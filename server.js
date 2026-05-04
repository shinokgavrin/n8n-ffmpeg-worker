const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

app.post('/render', async (req, res) => {
    const { videoUrl, textParams } = req.body;
    
    const jobId = randomUUID();
    const inputPath = path.join(__dirname, `input_${jobId}.mp4`);
    const outputPath = path.join(__dirname, `output_${jobId}.mp4`);

    try {
        console.log(`[Job ${jobId}] Downloading video from: ${videoUrl}`);
        
        const response = await axios({ 
            url: videoUrl, 
            responseType: 'stream',
            timeout: 30000 
        });
        
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`[Job ${jobId}] Video downloaded. Starting FFmpeg processing...`);
        
        // Test filter to ensure Cyrillic and Emojis render correctly
        const drawtextFilter = `drawtext=font='Roboto Bold':text='${textParams}':fontcolor=white:fontsize=80:x=(w-text_w)/2:y=(h-text_h)/2`;

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoFilters(drawtextFilter)
                .outputOptions('-c:a copy')
                .save(outputPath)
                .on('end', () => {
                    console.log(`[Job ${jobId}] Processing complete. Sending file...`);
                    res.download(outputPath, `final_video_${jobId}.mp4`, (err) => {
                        if (err) console.error(`[Job ${jobId}] Download transmission error:`, err);
                        resolve(); 
                    });
                })
                .on('error', (err) => {
                    console.error(`[Job ${jobId}] FFmpeg Error:`, err);
                    reject(err);
                });
        });

    } catch (error) {
        console.error(`[Job ${jobId}] Server Error:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Processing failed', details: error.message });
        }
    } finally {
        console.log(`[Job ${jobId}] Cleaning up temp files...`);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Worker listening on port ${PORT}`);
});
