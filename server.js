const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('canvas'); 

const app = express();
app.use(express.json());

app.get('/debug', (req, res) => {
    const info = {};
    try { info.emojiFont = execSync('fc-list | grep -i emoji').toString().trim(); } 
    catch(e) { info.emojiFont = 'NOT FOUND: ' + e.message; }
    try { info.freetype = execSync('dpkg -l libfreetype6 | tail -1').toString().trim(); }
    catch(e) { info.freetype = 'unknown: ' + e.message; }
    try { info.cairo = execSync('dpkg -l libcairo2 | tail -1').toString().trim(); }
    catch(e) { info.cairo = 'unknown: ' + e.message; }
    
    console.log("=== SYSTEM DIAGNOSTICS ===");
    console.log(JSON.stringify(info, null, 2));
    
    try {
        const canvas = createCanvas(400, 100);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 400, 100);
        ctx.font = 'bold 60px Roboto';
        ctx.fillStyle = 'white';
        ctx.textBaseline = 'middle';
        ctx.fillText('Test Text', 10, 50);
        const buffer = canvas.toBuffer('image/png');
        res.set('Content-Type', 'image/png');
        return res.send(buffer);
    } catch(e) {
        info.canvasError = e.message;
        return res.json(info);
    }
});

async function renderSubtitleImage(text, outputPath) {
    const canvas = createCanvas(1080, 1920); 
    const ctx = canvas.getContext('2d');
    
    if (!text || text.trim() === "") {
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        return;
    }
    
    ctx.textBaseline = 'middle';

    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let emojis = [];
    let cleanText = text;
    let match;

    while ((match = emojiRegex.exec(text)) !== null) {
        emojis.push(match[0]);
        cleanText = cleanText.replace(match[0], ''); 
    }
    cleanText = cleanText.trim();

    // ACCURATE MEASUREMENT FIX: Pre-measure each letter with its exact font size
    let trueTextWidth = 0;
    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i];
        const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();
        ctx.font = isUpper ? 'bold 90px Roboto' : 'bold 80px Roboto';
        trueTextWidth += ctx.measureText(char).width;
    }

    const emojiSize = 80;
    const spacing = emojis.length > 0 ? 25 : 0; 
    const totalWidth = trueTextWidth + spacing + (emojis.length > 0 ? emojiSize : 0);

    const padding = 40;
    const startX = (1080 - totalWidth) / 2;
    const boxX = startX - padding;
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(boxX, 1400, totalWidth + (padding * 2), 160);
    
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round'; 
    
    let finalCursorX = startX;

    if (cleanText.length > 0) {
        let currentCursorX = startX;

        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();

            if (isUpper) {
                ctx.fillStyle = '#FFD700';       
                ctx.strokeStyle = 'black';       
                ctx.font = 'bold 90px Roboto';   
            } else {
                ctx.fillStyle = 'white';         
                ctx.strokeStyle = 'black';       
                ctx.font = 'bold 80px Roboto';   
            }

            ctx.lineWidth = 8; 
            
            ctx.strokeText(char, currentCursorX, 1480);
            ctx.fillText(char, currentCursorX, 1480);
            
            currentCursorX += ctx.measureText(char).width;
        }
        // Save the exact pixel where the text ended
        finalCursorX = currentCursorX;
    }
    
    if (emojis.length > 0) {
        const emojiChar = emojis[0]; 
        let codePoint = emojiChar.codePointAt(0).toString(16);
        
        if (emojiChar.length > 2) {
             const points = [];
             for (const cp of emojiChar) points.push(cp.codePointAt(0).toString(16));
             codePoint = points.filter(p => p !== 'fe0f').join('-'); 
        }

        const twemojiUrl = `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${codePoint}.png`;

        try {
            const image = await loadImage(twemojiUrl);
            // Drop the emoji exactly after the finalCursorX
            const emojiX = cleanText.length > 0 ? finalCursorX + spacing : startX;
            ctx.drawImage(image, emojiX, 1480 - (emojiSize / 2), emojiSize, emojiSize);
        } catch (err) {
            console.error(`[Warning] Could not load emoji: ${twemojiUrl}`);
        }
    }

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
        let attempts = 0;
        const maxAttempts = 8;
        
        // --- NEW RETRY LOGIC START ---
        while (attempts < maxAttempts) {
            try {
                const response = await axios({
                    url: videoUrl,
                    responseType: 'stream',
                    timeout: 45000
                });
                const writer = fs.createWriteStream(inputPath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                break; // success
            } catch (err) {
                attempts++;
                if (err.response?.status === 423 && attempts < maxAttempts) {
                    console.log(`[Job ${jobId}] Cloudinary 423 - waiting ${attempts * 3}s before retry...`);
                    await new Promise(r => setTimeout(r, attempts * 3000));
                    continue;
                }
                throw err; // real error
            }
        }
        // --- NEW RETRY LOGIC END ---

        console.log(`[Job ${jobId}] Compiling subtitle track...`);
        
        await renderSubtitleImage("", blankPath);
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
            
            await renderSubtitleImage(sub.text, imgPath);
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
        console.log(`[Job ${jobId}] Cleaning up files...`);
        generatedFiles.forEach(file => { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {} });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
