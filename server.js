const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
// IMPORT LOADIMAGE: Needed to download the emoji graphic from the internet
const { createCanvas, loadImage } = require('canvas'); 

const app = express();
app.use(express.json());

// --- DEBUG ENDPOINT ---
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

// --- SUBTITLE RENDERER (THE TWEMOJI OVERRIDE) ---
// Note: This is now an async function because it downloads an image
async function renderSubtitleImage(text, outputPath) {
    // Canvas is now natively vertical (1080x1920)
    const canvas = createCanvas(1080, 1920); 
    const ctx = canvas.getContext('2d');
    
    if (!text || text.trim() === "") {
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        return;
    }
    
    // We only need Roboto now. No more color font fallbacks!
    ctx.font = 'bold 80px Roboto'; 
    ctx.textBaseline = 'middle';

    // 1. Separate the text and the emoji using a Unicode Regex
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let emojis = [];
    let cleanText = text;
    let match;

    while ((match = emojiRegex.exec(text)) !== null) {
        emojis.push(match[0]);
        cleanText = cleanText.replace(match[0], ''); 
    }
    cleanText = cleanText.trim();

    // 2. Measure everything to keep the dark plate perfectly centered
    const textWidth = ctx.measureText(cleanText).width;
    const emojiSize = 80;
    const spacing = emojis.length > 0 ? 25 : 0; 
    const totalWidth = textWidth + spacing + (emojis.length > 0 ? emojiSize : 0);

    const padding = 40;
    // Centering math now uses 1080 width
    const startX = (1080 - totalWidth) / 2;
    const boxX = startX - padding;
    
    // 3. Draw Background Plate - Moved down to 1400 (lower third of vertical video)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(boxX, 1400, totalWidth + (padding * 2), 160);
    
    // 4. Draw White Text - Moved down to 1480
    ctx.fillStyle = 'white';
    ctx.textAlign = 'left';
    if (cleanText.length > 0) {
        ctx.fillText(cleanText, startX, 1480); 
    }
    
    // 5. Draw the Full-Color Emoji from Twitter's CDN - Moved down to 1480
    if (emojis.length > 0) {
        const emojiChar = emojis[0]; 
        // Convert the emoji to its hex code point so we can look it up
        let codePoint = emojiChar.codePointAt(0).toString(16);
        
        // Handle complex emojis (like ones with variations or genders)
        if (emojiChar.length > 2) {
             const points = [];
             for (const cp of emojiChar) points.push(cp.codePointAt(0).toString(16));
             codePoint = points.filter(p => p !== 'fe0f').join('-'); // Strip variation selector
        }

        const twemojiUrl = `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${codePoint}.png`;

        try {
            const image = await loadImage(twemojiUrl);
            // Draw it perfectly aligned to the right of the text
            const emojiX = cleanText.length > 0 ? startX + textWidth + spacing : startX;
            ctx.drawImage(image, emojiX, 1480 - (emojiSize / 2), emojiSize, emojiSize);
        } catch (err) {
            console.error(`[Warning] Could not load emoji graphic from: ${twemojiUrl}`);
        }
    }

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

// --- FFmpeg RENDER PIPELINE ---
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
        
        // AWAIT added because renderSubtitleImage is now an async function
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
            
            // AWAIT added here as well
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
        console.log(`[Job ${jobId}] Cleaning up ${generatedFiles.length} files...`);
        generatedFiles.forEach(file => { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {} });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
