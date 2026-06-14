const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { createCanvas, loadImage } = require('canvas');

const app = express();
app.use(express.json({ limit: '50mb' }));

const WORK_DIR = os.tmpdir(); 

app.get('/debug', (req, res) => {
    res.send("Multifunctional AI Video Worker v14.3 (JIT Memory Architecture) is active!");
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        queueLength: jobQueue.length,
        isProcessing: isProcessing,
        uptime: process.uptime(),
        cpuLoad1Min: os.loadavg()[0].toFixed(2),
        memoryUsageMB: {
            rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
            heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
            heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
        }
    });
});

const jobQueue = [];
let isProcessing = false;
let activeTask = null; 

process.on('SIGTERM', async () => {
    console.log('\n[System] ⚠️ SIGTERM received from Railway. Container is being killed!');
    if (activeTask && activeTask.webhookUrl) {
        console.log(`[System] Notifying n8n webhook to abort Wait node for Job ${activeTask.jobId}...`);
        try {
            await axios.post(activeTask.webhookUrl, { 
                error: 'Worker terminated by platform (SIGTERM / OOM)',
                jobId: activeTask.jobId,
                status: "failed"
            });
            console.log('[System] n8n notified successfully.');
        } catch(e) {}
    }
    process.exit(0);
});

async function downloadFile(url, dest, jobId = '') {
    let attempts = 0;
    const maxAttempts = 6;
    while (attempts < maxAttempts) {
        try {
            const response = await axios({ url, responseType: 'stream', timeout: 90000, maxRedirects: 5 });
            const writer = fs.createWriteStream(dest);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
            return;
        } catch (err) {
            attempts++;
            if (err.response?.status === 423 && attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, attempts * 4500));
                continue;
            }
            if (attempts >= maxAttempts) throw new Error(`Download failed: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function renderSubtitleImage(text, outputPath) {
    const canvas = createCanvas(1080, 1920);
    const ctx = canvas.getContext('2d');
    if (!text || text.trim() === "") {
        fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
        return;
    }
    ctx.textBaseline = 'middle';
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let emojis = [], cleanText = text, match;
    while ((match = emojiRegex.exec(text)) !== null) {
        emojis.push(match[0]);
        cleanText = cleanText.replace(match[0], '');
    }
    cleanText = cleanText.trim();

    let trueTextWidth = 0;
    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i];
        ctx.font = (char === char.toUpperCase() && char !== char.toLowerCase()) ? 'bold 90px Roboto' : 'bold 80px Roboto';
        trueTextWidth += ctx.measureText(char).width;
    }

    const emojiSize = 80;
    const spacing = emojis.length > 0 ? 25 : 0;
    const totalWidth = trueTextWidth + spacing + (emojis.length > 0 ? emojiSize : 0);
    const padding = 40, startX = (1080 - totalWidth) / 2, boxX = startX - padding;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(boxX, 1400, totalWidth + (padding * 2), 160);
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    let currentCursorX = startX;

    if (cleanText.length > 0) {
        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();
            ctx.fillStyle = isUpper ? '#FFD700' : 'white';
            ctx.strokeStyle = 'black';
            ctx.font = isUpper ? 'bold 90px Roboto' : 'bold 80px Roboto';
            ctx.lineWidth = 8;
            ctx.strokeText(char, currentCursorX, 1480);
            ctx.fillText(char, currentCursorX, 1480);
            currentCursorX += ctx.measureText(char).width;
        }
    }

    if (emojis.length > 0) {
        let codePoint = emojis[0].codePointAt(0).toString(16);
        if (emojis[0].length > 2) {
            codePoint = Array.from(emojis[0]).map(cp => cp.codePointAt(0).toString(16)).filter(p => p !== 'fe0f').join('-');
        }
        try {
            const image = await loadImage(`https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${codePoint}.png`);
            ctx.drawImage(image, cleanText.length > 0 ? currentCursorX + spacing : startX, 1480 - (emojiSize / 2), emojiSize, emojiSize);
        } catch (err) {}
    }
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    
    isProcessing = true;
    activeTask = jobQueue.shift(); 
    const { videoUrl, subtitles, keep_segments, actions, webhookUrl, jobId } = activeTask;

    const inputPath = path.join(WORK_DIR, `input_${jobId}.mp4`);
    const burnedPath = path.join(WORK_DIR, `burned_${jobId}.mp4`);
    const finalPath = path.join(WORK_DIR, `final_${jobId}.mp4`);
    const concatTxtPath = path.join(WORK_DIR, `concat_${jobId}.txt`);
    const blankPath = path.join(WORK_DIR, `blank_${jobId}.png`);
    
    let generatedFiles = [inputPath, burnedPath, finalPath, concatTxtPath, blankPath];

    try {
        console.log(`\n======================================================`);
        console.log(`[Job ${jobId}] === STARTING V14.3 JIT ARCHITECTURE ===`);
        console.log(`[Job ${jobId}] Queue Status: ${jobQueue.length} jobs remaining.`);
        console.log(`======================================================\n`);
        
        await downloadFile(videoUrl, inputPath, jobId);
        let currentVideo = inputPath;

        // PHASE 1: SUBTITLES
        const hasSubtitles = subtitles && Array.isArray(subtitles) && subtitles.length > 0;
        if (hasSubtitles) {
            console.log(`[Job ${jobId}] Phase 1: Burning subtitles...`);
            await renderSubtitleImage("", blankPath);
            let concatText = "ffconcat version 1.0\n", currentTime = 0;

            for (let i = 0; i < subtitles.length; i++) {
                const sub = subtitles[i], start = parseFloat(sub.start), end = parseFloat(sub.end);
                if (start > currentTime) concatText += `file 'blank_${jobId}.png'\nduration ${(start - currentTime).toFixed(2)}\n`;
                const imgName = `sub_${jobId}_${i}.png`, imgPath = path.join(WORK_DIR, imgName);
                await renderSubtitleImage(sub.text, imgPath);
                generatedFiles.push(imgPath);
                concatText += `file '${imgName}'\nduration ${(end - start).toFixed(2)}\n`;
                currentTime = end;
            }
            concatText += `file 'blank_${jobId}.png'\nduration 1.00\n`;
            fs.writeFileSync(concatTxtPath, concatText);

            await new Promise((resolve, reject) => {
                let command = ffmpeg(inputPath)
                    .renice(15)
                    .input(concatTxtPath).inputOptions(['-f', 'concat', '-safe', '0'])
                    .complexFilter(['[0:v][1:v]overlay=x=0:y=0:eof_action=pass[outv]'], 'outv')
                    .outputOptions(['-map 0:a', '-c:a copy', '-c:v libx264', '-pix_fmt yuv420p', '-preset ultrafast', '-threads 1']);

                command.on('start', (cmdLine) => console.log(`[Job ${jobId}] [Phase 1 - Subtitles] Command: \n${cmdLine}`))
                       .on('error', (err) => reject(err))
                       .on('end', () => resolve());

                command.save(burnedPath);
            });
            currentVideo = burnedPath;
        }

        // PHASE 2: SAFE LAYERING (Just-In-Time Downloading)
        let muteActions = [], overlayActions = [];
        if (actions && Array.isArray(actions)) {
            muteActions = actions.filter(a => ['mute_title', 'mute'].includes(a.type));
            overlayActions = actions.filter(a => ['overlay_gif', 'overlay_image', 'overlay'].includes(a.type));
        }
        
        if (muteActions.length > 0 || overlayActions.length > 0) {
            console.log(`\n[Job ${jobId}] === Phase 2: Overlay Processing ===`);
            
            const totalBatches = overlayActions.length > 0 ? overlayActions.length : 1;

            for (let b = 0; b < totalBatches; b++) {
                const isLastBatch = (b === totalBatches - 1);
                const batchOverlays = overlayActions.slice(b, b + 1);
                const batchOutputPath = path.join(WORK_DIR, `layer_${jobId}_${b}.mp4`);
                generatedFiles.push(batchOutputPath);

                // --- JUST IN TIME DOWNLOAD ---
                for (let action of batchOverlays) {
                    if (action.url) {
                        const ext = path.extname(action.asset_name || '').toLowerCase() || '.png';
                        const localPath = path.join(WORK_DIR, `asset_${jobId}_${b}${ext}`);
                        console.log(`[Job ${jobId}] [Layer ${b + 1}] Downloading asset Just-In-Time...`);
                        await downloadFile(action.url, localPath, jobId);
                        action.localPath = localPath;
                        action.isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
                        action.isGif = ext === '.gif';
                    }
                }

                console.log(`\n[Job ${jobId}] --- Applying Layer ${b + 1}/${totalBatches} ---`);
                
                let command = ffmpeg(currentVideo).renice(15); 
                command.inputOptions(['-thread_queue_size', '512', '-threads', '1']);

                batchOverlays.forEach(action => {
                    if (action.localPath) {
                        let options = ['-thread_queue_size', '256', '-threads', '1']; 
                        if (action.isGif) options.push('-ignore_loop', '0'); 
                        else if (action.isVideo) options.push('-stream_loop', '-1'); 
                        else options.push('-loop', '1'); 
                        command.input(action.localPath).inputOptions(options);
                    }
                });

                let complexFilters = [];
                let outputOptions = ['-pix_fmt yuv420p', '-shortest', '-threads', '1', '-filter_threads', '1', '-max_muxing_queue_size', '9999'];

                if (isLastBatch) outputOptions.push('-c:v libx264', '-crf 22', '-preset ultrafast');
                else outputOptions.push('-c:v libx264', '-crf 16', '-preset ultrafast');

                if (b === 0) {
                    outputOptions.push('-c:a aac');
                    if (muteActions.length > 0) {
                        const volumeFilters = muteActions.map(m => `volume=0:enable='between(t,${parseFloat(m.start_time)},${parseFloat(m.end_time)})'`).join(',');
                        complexFilters.push(`[0:a]${volumeFilters}[outa]`);
                        outputOptions.push('-map [outa]');
                    } else {
                        outputOptions.push('-map 0:a');
                    }
                } else {
                    outputOptions.push('-c:a copy', '-map 0:a');
                }

                if (batchOverlays.length > 0) {
                    let currentVidNode = '[0:v]';
                    batchOverlays.forEach((action, idx) => {
                        const nextVidNode = '[outv]';
                        const scaledNode = `[scaled_v1]`;
                        const MAX_W = parseInt(action.max_width) || 800, MAX_H = parseInt(action.max_height) || 800;
                        complexFilters.push(`[1:v]scale='min(${MAX_W},iw):min(${MAX_H},ih):force_original_aspect_ratio=decrease'${scaledNode}`);
                        complexFilters.push(`${currentVidNode}${scaledNode}overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${parseFloat(action.start_time)},${parseFloat(action.end_time)})':eof_action=pass${nextVidNode}`);
                    });
                    outputOptions.push('-map [outv]');
                } else {
                    outputOptions.push('-map 0:v');
                }

                if (complexFilters.length > 0) command.complexFilter(complexFilters);
                command.outputOptions(outputOptions);

                await new Promise((resolve, reject) => {
                    let lastLogTime = 0; 
                    command.on('start', () => console.log(`[Job ${jobId}] [Layer ${b + 1}] Executing FFmpeg command...`))
                    .on('progress', (progress) => {
                        const now = Date.now();
                        if (progress.percent && progress.percent > 0 && (now - lastLogTime > 2000)) {
                            process.stdout.write(`\r[Job ${jobId}] [Layer ${b + 1}] Progress: ${progress.percent.toFixed(1)}% | RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);
                            lastLogTime = now;
                        }
                    })
                    .on('error', (err) => reject(err))
                    .on('end', () => {
                        console.log(`\n[Job ${jobId}] [Layer ${b + 1}] Completed.`);
                        resolve();
                    });

                    command.save(batchOutputPath);
                });

                // ==========================================
                // AGGRESSIVE JIT MEMORY CLEANUP
                // ==========================================
                const prevVideo = currentVideo; 
                currentVideo = batchOutputPath;
                command = null; // Free FFmpeg object from memory
                
                // Aggressively delete the previous base video (even if it is the raw 500MB input)
                if (fs.existsSync(prevVideo)) {
                    try { fs.unlinkSync(prevVideo); } catch(e) {}
                }

                // Instantly delete the MP4 overlay asset to clear buffer cache
                batchOverlays.forEach(action => {
                    if (action.localPath && fs.existsSync(action.localPath)) {
                        try { fs.unlinkSync(action.localPath); action.localPath = null; } catch (e) {}
                    }
                });

                if (global.gc) global.gc(); // Force V8 to clear the memory
                await new Promise(r => setTimeout(r, 4000));
            }
        }

        // PHASE 3: JUMP CUTS
        const hasCuts = keep_segments && Array.isArray(keep_segments) && keep_segments.length > 0;
        if (hasCuts) {
            console.log(`\n[Job ${jobId}] === Phase 3: Performing jump cuts ===`);
            let filterComplex = '', concatInputs = '';
            keep_segments.forEach((seg, i) => {
                filterComplex += `[0:v]trim=start=${parseFloat(seg.start)}:end=${parseFloat(seg.end)},setpts=PTS-STARTPTS[v${i}]; `;
                filterComplex += `[0:a]atrim=start=${parseFloat(seg.start)}:end=${parseFloat(seg.end)},asetpts=PTS-STARTPTS[a${i}]; `;
                concatInputs += `[v${i}][a${i}]`;
            });
            filterComplex += `${concatInputs}concat=n=${keep_segments.length}:v=1:a=1[outv][outa]`;

            await new Promise((resolve, reject) => {
                let lastLogTime = 0;
                let command = ffmpeg(currentVideo)
                    .renice(15) 
                    .complexFilter(filterComplex, ['outv', 'outa'])
                    .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-preset ultrafast', '-crf 22', '-threads 1']);

                command.on('progress', (progress) => {
                        const now = Date.now();
                        if (progress.percent && progress.percent > 0 && (now - lastLogTime > 2000)) {
                            process.stdout.write(`\r[Job ${jobId}] [Phase 3] Progress: ${progress.percent.toFixed(1)}% | RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);
                            lastLogTime = now;
                        }
                    })
                    .on('error', (err) => reject(err))
                    .on('end', () => resolve());

                command.save(finalPath);
            });
            currentVideo = finalPath;
            command = null;
        }

        if (webhookUrl) {
            console.log(`\n[Job ${jobId}] Sending video to webhook: ${webhookUrl}`);
            const fileStream = fs.createReadStream(currentVideo);
            await axios.post(webhookUrl, fileStream, {
                headers: { 'Content-Type': 'video/mp4' },
                maxContentLength: Infinity, maxBodyLength: Infinity
            });
            console.log(`[Job ${jobId}] Webhook delivered successfully!`);
        }

    } catch (error) {
        console.error(`\n[Job ${jobId}] Critical Error:`, error.message);
    } finally {
        console.log(`\n[Job ${jobId}] Cleaning up final temporary files...`);
        generatedFiles.forEach(file => { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {} });
        activeTask = null;
        isProcessing = false;
        if (global.gc) global.gc();
        processQueue(); 
    }
}

app.post('/render', (req, res) => {
    const jobId = randomUUID();
    res.status(202).json({ message: "Job added to queue. Rendering in background...", jobId: jobId });
    jobQueue.push({ ...req.body, jobId });
    processQueue();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Multifunctional AI Video Worker running on port ${PORT}`));
