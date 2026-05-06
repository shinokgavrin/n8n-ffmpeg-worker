const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createCanvas } = require('canvas');

const app = express();
app.use(express.json());

function renderSubtitleImage(text, outputPath) {
    const canvas = createCanvas(1920, 1080); 
    const ctx = canvas.getContext('2d');
    
    if (!text || text.trim() === "") {
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        return;
    }
    
    // With canvas built from source, this will finally render in full color!
    ctx.font = 'bold 80px Roboto, "Noto Color Emoji"';
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    const textWidth = ctx.measureText(text).width * 1.2; 
    const padding = 40;
    const boxX = (1920 - textWidth) / 2 - padding;
    ctx.fillRect(boxX, 800, textWidth + (padding * 2), 160);
    
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.fillText(text, 1920 / 2, 880); 
    
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

app.post('/render', async (req, res) => {
    const { videoUrl, subtitles } = req.body; 
    const jobId = randomUUID();
    const inputPath = path.join(__dirname, `input_${jobId}.mp4`);
    const outputPath = path.join(__dirname, `output_${jobId}.mp4`);
    const concatTxtPath = path.join(__dirname, `concat_${jobId}.txt`);
    const blankPath = path.join(__dirname, `blank_${jobId}.png`);
    
    let generatedFiles = [inputPath, outputPath, concatTxtPath, blankPath];

    try {
        console.log(`[Job ${jobId}] Downloading video...`);
        const response = await axios({ url: videoUrl, responseType: 'stream', timeout: 30000 });
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

        console.log(`[Job ${jobId}] Compiling subtitle track...`);
        
        renderSubtitleImage("", blankPath);
        let concatText = "ffconcat version 1.0\n";
        let currentTime = 0;

        for (let i = 0; i < subtitles.length; i++) {
            const sub = subtitles[i];
            const start = parseFloat(sub.start);
            const end = parseFloat(sub.end);

            if (start > currentTime) {
                concatText += `file 'blank_${jobId}.png'\n`;
                concatText += `duration ${(start - currentTime).toFixed(2)}\n`;
            }

            const imgName = `sub_${jobId}_${i}.png`;
            const imgPath = path.join(__dirname, imgName);
            renderSubtitleImage(sub.text, imgPath);
            generatedFiles.push(imgPath);

            concatText += `file '${imgName}'\n`;
            concatText += `duration ${(end - start).toFixed(2)}\n`;

            currentTime = end;
        }

        concatText += `file 'blank_${jobId}.png'\n`;
        concatText += `duration 1.00\n`;
        fs.writeFileSync(concatTxtPath, concatText);

        console.log(`[Job ${jobId}] Starting FFmpeg composite...`);
        
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .input(concatTxtPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .complexFilter(['[0:v][1:v]overlay=x=0:y=0:eof_action=pass[outv]'], 'outv')
                .outputOptions([
                    '-map 0:a',          
                    '-c:a copy',         
                    '-c:v libx264',      
                    '-pix_fmt yuv420p'   
                ])
                .save(outputPath)
                .on('end', () => {
                    console.log(`[Job ${jobId}] Success. Sending file...`);
                    res.download(outputPath, `final_video_${jobId}.mp4`, (err) => { if (err) resolve(); resolve(); });
                })
                .on('error', reject);
        });

    } catch (error) {
        console.error(`[Job ${jobId}] Error:`, error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Processing failed', details: error.message });
    } finally {
        console.log(`[Job ${jobId}] Cleaning up ${generatedFiles.length} files...`);
        generatedFiles.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
