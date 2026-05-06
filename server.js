const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createCanvas } = require('canvas');

const app = express();
app.use(express.json());

// Kept your sleek 1920x200 canvas
function renderSubtitleImage(text, outputPath) {
    const canvas = createCanvas(1920, 200); 
    const ctx = canvas.getContext('2d');
    
    ctx.font = 'bold 80px Roboto, "Noto Color Emoji"';
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    const textWidth = ctx.measureText(text).width * 1.2; 
    const padding = 40;
    const boxX = (1920 - textWidth) / 2 - padding;
    ctx.fillRect(boxX, 20, textWidth + (padding * 2), 160);
    
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.fillText(text, 1920 / 2, 100); 
    
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
}

app.post('/render', async (req, res) => {
    const { videoUrl, subtitles } = req.body; 
    const jobId = randomUUID();
    const inputPath = path.join(__dirname, `input_${jobId}.mp4`);
    const outputPath = path.join(__dirname, `output_${jobId}.mp4`);
    
    let generatedFiles = [inputPath, outputPath];

    try {
        console.log(`[Job ${jobId}] Downloading video...`);
        const response = await axios({ url: videoUrl, responseType: 'stream', timeout: 30000 });
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

        console.log(`[Job ${jobId}] Creating subtitle images...`);
        let ffmpegCommand = ffmpeg(inputPath);
        let filterParts = [];
        
        for (let i = 0; i < subtitles.length; i++) {
            const sub = subtitles[i];
            const imgPath = path.join(__dirname, `sub_${jobId}_${i}.png`);
            
            renderSubtitleImage(sub.text, imgPath);
            generatedFiles.push(imgPath);
            
            const duration = parseFloat(sub.end) - parseFloat(sub.start) + 0.1;
            
            // THE FIX: Loop the image so it behaves like a video stream!
            ffmpegCommand = ffmpegCommand
                .input(imgPath)
                .inputOptions([
                    '-loop 1',
                    '-framerate 25',
                    `-t ${duration}`
                ]);
            
            const idx = i + 1;
            const prevLabel = i === 0 ? '0:v' : `v${i}`;
            const nextLabel = `v${i + 1}`;
            
            // THE FIX: Use setpts to align timestamps, and eof_action=pass to clear the screen
            filterParts.push(
                `[${idx}:v]setpts=PTS+${sub.start}/TB[img${idx}]`,
                `[${prevLabel}][img${idx}]overlay=x=0:y=H-h-150:shortest=0:eof_action=pass[${nextLabel}]`
            );
        }

        const filterComplex = filterParts.join(';');

        console.log(`[Job ${jobId}] Starting FFmpeg composite (Timestamp Method)...`);
        await new Promise((resolve, reject) => {
            ffmpegCommand
                .complexFilter(filterComplex, `v${subtitles.length}`)
                .outputOptions('-c:a copy')
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
