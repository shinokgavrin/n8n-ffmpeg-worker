const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { createCanvas, loadImage } = require('canvas');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// INFRASTRUCTURE FIX: Automatically use persistent volume if attached to prevent Disk Eviction
let WORK_DIR = os.tmpdir();
if (fs.existsSync('/app/workspace')) {
    WORK_DIR = '/app/workspace';
    console.log('[System] Persistent Railway Volume detected. Routing all video data to /app/workspace');
}

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.status(200).send("OK"));

app.get('/debug', (req, res) => {
    res.send("Multifunctional AI Video Worker v15.5 (Cinematic TTS Audio Mixing) is active!");
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        queueLength: jobQueue.length,
        isProcessing: isProcessing,
        uptime: process.uptime()
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
                error: 'Worker terminated by platform (SIGTERM / Hard Timeout)',
                jobId: activeTask.jobId,
                status: "failed"
            });
            console.log('[System] n8n notified successfully.');
        } catch(e) {}
    }
    process.exit(0);
});

// Upgraded R2 Uploader
async function uploadToR2(filePath, fileName) {
    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
        throw new Error("Missing Cloudflare R2 environment variables. Cannot perform R2 upload.");
    }

    const cleanEndpoint = process.env.R2_ENDPOINT.startsWith('https://') 
        ? process.env.R2_ENDPOINT 
        : `https://${process.env.R2_ENDPOINT}`;

    const s3 = new S3Client({
        region: 'auto',
        endpoint: cleanEndpoint,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    });

    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);

    const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `renders/${fileName}`,
        Body: fileStream,
        ContentLength: stats.size,
        ContentType: 'video/mp4'
    });

    await s3.send(command);

    const r2UrlBase = process.env.R2_PUBLIC_URL.replace(/\/$/, ''); 
    return `${r2UrlBase}/renders/${fileName}`;
}

// UPGRADED JIT DOWNLOADER: Catches fake videos, HTML pages, and broken URLs
async function downloadFile(url, dest, jobId = '') {
    let attempts = 0;
    const maxAttempts = 6;
    while (attempts < maxAttempts) {
        try {
            const response = await axios({ url, responseType: 'stream', timeout: 90000, maxRedirects: 5 });
            
            // SECURITY CHECK 1: Ensure it's not a webpage
            const contentType = response.headers['content-type'] || '';
            if (contentType.includes('text/html')) {
                throw new Error(`The URL provided a webpage (HTML), not a raw media file: ${url}`);
            }

            const writer = fs.createWriteStream(dest);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
            
            // SECURITY CHECK 2: Ensure it has physical weight (not an empty file)
            const stats = fs.statSync(dest);
            if (stats.size < 1000) { // Tiny files are errors
                fs.unlinkSync(dest); 
                throw new Error(`The downloaded file is impossibly small (${stats.size} bytes). It is likely an expired link: ${url}`);
            }

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
        console.log(`[Job ${jobId}] === STARTING V15.5 AUDIO-MIX RENDER ===`);
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
                    .outputOptions(['-map 0:a', '-c:a copy', '-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 24', '-threads 1']);

                command.on('start', (cmdLine) => console.log(`[Job ${jobId}] [Phase 1 - Subtitles] Command: \n${cmdLine}`))
                       .on('error', (err) => reject(err))
                       .on('end', () => resolve());

                command.save(burnedPath);
            });
            currentVideo = burnedPath;
        }

        // PHASE 2: SAFE LAYERING & MULTI-INPUT TTS AUDIO MIXING
        let muteActions = [], overlayActions = [];
        if (actions && Array.isArray(actions)) {
            muteActions = actions.filter(a => ['mute_title', 'mute'].includes(a.type));
            overlayActions = actions.filter(a => ['overlay_gif', 'overlay_image', 'overlay'].includes(a.type));
        }
        
        if (muteActions.length > 0 || overlayActions.length > 0) {
            console.log(`\n[Job ${jobId}] === Phase 2: Parallel Overlay & TTS Audio Processing ===`);
            
            const batchOutputPath = path.join(WORK_DIR, `layered_batch_${jobId}.mp4`);
            generatedFiles.push(batchOutputPath);

            // 1. Download ALL graphic overlay assets in parallel first
            for (let i = 0; i < overlayActions.length; i++) {
                let action = overlayActions[i];
                if (action.url) {
                    const ext = path.extname(action.asset_name || '').toLowerCase() || '.png';
                    const localPath = path.join(WORK_DIR, `asset_${jobId}_${i}${ext}`);
                    console.log(`[Job ${jobId}] Downloading overlay asset ${i + 1}/${overlayActions.length} JIT...`);
                    await downloadFile(action.url, localPath, jobId);
                    action.localPath = localPath;
                    action.isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
                    action.isGif = ext === '.gif';
                }
            }

            // 2. Download ALL generated TTS transition audio clips in parallel
            let ttsActionsWithAudio = muteActions.filter(a => a.url);
            for (let i = 0; i < ttsActionsWithAudio.length; i++) {
                let action = ttsActionsWithAudio[i];
                const localPath = path.join(WORK_DIR, `tts_${jobId}_${i}.mp3`);
                console.log(`[Job ${jobId}] Downloading TTS transition track ${i + 1}/${ttsActionsWithAudio.length}...`);
                await downloadFile(action.url, localPath, jobId);
                action.localPath = localPath;
            }

            console.log(`\n[Job ${jobId}] --- Compiling Single-Pass Composite Filter Schema ---`);
            
            let command = ffmpeg(currentVideo).renice(15); 
            command.inputOptions(['-thread_queue_size', '1024', '-threads', '4']);

            // 3. Map Graphic Assets as Parallel Inputs
            overlayActions.forEach(action => {
                if (action.localPath) {
                    let options = ['-thread_queue_size', '1024']; 
                    if (action.isGif) options.push('-ignore_loop', '0'); 
                    else if (action.isVideo) options.push('-stream_loop', '-1'); 
                    else options.push('-loop', '1'); 
                    command.input(action.localPath).inputOptions(options);
                }
            });

            // 4. Map TTS Audio Assets as Parallel Inputs
            ttsActionsWithAudio.forEach(action => {
                command.input(action.localPath).inputOptions(['-thread_queue_size', '1024']);
            });

            let complexFilters = [];
            let outputOptions = ['-pix_fmt yuv420p', '-shortest', '-threads', '4', '-filter_threads', '4', '-max_muxing_queue_size', '2048'];
            outputOptions.push('-c:v libx264', '-preset veryfast', '-crf 24', '-maxrate 6M', '-bufsize 12M');
            outputOptions.push('-c:a aac');

            // 5. AUDIO ROUTING: Mute the host, and mix in TTS audio tracks dynamically using adelay
            let hostAudioNode = '[0:a]';
            if (muteActions.length > 0) {
                const volumeFilters = muteActions.map(m => `volume=0:enable='between(t,${parseFloat(m.start_time)},${parseFloat(m.end_time)})'`).join(',');
                complexFilters.push(`[0:a]${volumeFilters}[muted_host]`);
                hostAudioNode = '[muted_host]';
            }

            if (ttsActionsWithAudio.length > 0) {
                let amixInputs = [hostAudioNode];
                ttsActionsWithAudio.forEach((action, idx) => {
                    const inputIdx = 1 + overlayActions.length + idx; // Offset inputs by the count of video overlays
                    const startMs = Math.round(parseFloat(action.start_time) * 1000);
                    const delayedNode = `[tts_${idx}]`;
                    
                    // Delay the TTS mono/stereo track to start at the exact muted timestamp
                    complexFilters.push(`[${inputIdx}:a]adelay=${startMs}|${startMs}${delayedNode}`);
                    amixInputs.push(delayedNode);
                });

                // 🔥 AUDIO CORRECTION: Добавлен параметр :normalize=0 для отключения затухания и выравнивания громкости на 100%!
                complexFilters.push(`${amixInputs.join('')}amix=inputs=${amixInputs.length}:duration=first:dropout_transition=0:normalize=0[mixed_audio]`);
                outputOptions.push('-map [mixed_audio]');
            } else {
                // Если аудио не обрабатывается фильтрами (Pass 1+), мапим сырой 0:a БЕЗ квадратных скобок!
                if (hostAudioNode === '[0:a]') {
                    outputOptions.push('-map 0:a');
                } else {
                    outputOptions.push(`-map ${hostAudioNode}`);
                }
            }

            // 6. VIDEO ROUTING: Chain Graphic Overlays
            if (overlayActions.length > 0) {
                let currentVidNode = '[0:v]';
                overlayActions.forEach((action, idx) => {
                    const inputIdx = idx + 1; 
                    const fadedNode = `[faded_${idx}]`;
                    const nextVidNode = idx === overlayActions.length - 1 ? '[outv]' : `[v_temp_${idx}]`;
                    
                    const MAX_W = parseInt(action.max_width) || 1080;
                    const MAX_H = parseInt(action.max_height) || 1080;
                    const startTime = parseFloat(action.start_time);
                    const endTime = parseFloat(action.end_time);
                    const duration = endTime - startTime;
                    const fadeDuration = Math.min(0.4, duration / 3.5); 

                    let filter = `[${inputIdx}:v]scale='2*trunc(iw*min(${MAX_W}/iw\\,${MAX_H}/ih)/2):2*trunc(ih*min(${MAX_W}/iw\\,${MAX_H}/ih)/2)',format=pix_fmts=yuva420p`;
                    filter += `,setpts=PTS-STARTPTS+${startTime}/TB`;
                    filter += `,fade=type=in:start_time=${startTime}:duration=${fadeDuration}:alpha=1`;
                    filter += `,fade=type=out:start_time=${(endTime - fadeDuration).toFixed(3)}:duration=${fadeDuration}:alpha=1${fadedNode}`;
                    
                    complexFilters.push(filter);
                    complexFilters.push(`${currentVidNode}${fadedNode}overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${startTime},${endTime})':eof_action=pass${nextVidNode}`);
                    currentVidNode = nextVidNode;
                });
                outputOptions.push('-map [outv]');
            } else {
                outputOptions.push('-map 0:v');
            }

            if (complexFilters.length > 0) command.complexFilter(complexFilters);
            command.outputOptions(outputOptions);

            await new Promise((resolve, reject) => {
                let lastLogTime = 0; 
                command.on('start', () => console.log(`[Job ${jobId}] Executing composite single-pass audio/video overlay graph...`))
                .on('progress', (progress) => {
                    const now = Date.now();
                    if (progress.percent && progress.percent > 0 && (now - lastLogTime > 2000)) {
                        process.stdout.write(`\r[Job ${jobId}] Progress: ${progress.percent.toFixed(1)}% | RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);
                        lastLogTime = now;
                    }
                })
                .on('error', (err) => reject(err))
                .on('end', () => {
                    console.log(`\n[Job ${jobId}] Composition completed.`);
                    resolve();
                });

                command.save(batchOutputPath);
            });

            currentVideo = batchOutputPath;
            command = null; 

            // Clean up temporary local files
            overlayActions.forEach(action => {
                if (action.localPath && fs.existsSync(action.localPath)) {
                    try { fs.unlinkSync(action.localPath); } catch (e) {}
                }
            });
            ttsActionsWithAudio.forEach(action => {
                if (action.localPath && fs.existsSync(action.localPath)) {
                    try { fs.unlinkSync(action.localPath); } catch (e) {}
                }
            });

            if (global.gc) global.gc(); 
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
                    .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 24', '-threads 1']);

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

        // PHASE 4: CDN UPLOAD
        let outputUrl = null;
        const isR2Configured = process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT;

        if (isR2Configured) {
            console.log(`\n[Job ${jobId}] Phase 4: Uploading finalized video to Cloudflare R2...`);
            const r2FileName = `render_${jobId}_${Date.now()}.mp4`;
            outputUrl = await uploadToR2(currentVideo, r2FileName);
            console.log(`[Job ${jobId}] Upload successful. R2 Public CDN Link: ${outputUrl}`);
        } else {
            console.log(`\n[Job ${jobId}] Phase 4: R2 credentials missing. Falling back to classic raw binary transfer...`);
        }

        if (webhookUrl) {
            if (outputUrl) {
                console.log(`[Job ${jobId}] Delivering lightweight JSON webhook to n8n (Size: ~150 Bytes)...`);
                await axios.post(webhookUrl, {
                    status: "success",
                    jobId: jobId,
                    videoUrl: outputUrl,
                    currentVideoUrl: outputUrl 
                });
                console.log(`[Job ${jobId}] Webhook JSON signal delivered successfully!`);
            } else {
                console.log(`[Job ${jobId}] Streaming massive video back to n8n webhook...`);
                const fileStream = fs.createReadStream(currentVideo);
                await axios.post(webhookUrl, fileStream, {
                    headers: { 'Content-Type': 'video/mp4' },
                    maxContentLength: Infinity, maxBodyLength: Infinity
                });
                console.log(`[Job ${jobId}] Webhook binary stream delivered.`);
            }
        }

    } catch (error) {
        console.error(`\n[Job ${jobId}] Critical Error:`, error.message);
        
        if (webhookUrl) {
            console.log(`[Job ${jobId}] Sending failure notice back to n8n webhook...`);
            await axios.post(webhookUrl, { 
                error: error.message, 
                jobId: jobId, 
                status: "failed" 
            }).catch(e => console.log(`[Job ${jobId}] Failed to deliver error webhook.`));
        }

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
app.listen(PORT, '0.0.0.0', () => console.log(`Multifunctional AI Video Worker running on port ${PORT} (Bound to 0.0.0.0)`));

// INFRASTRUCTURE FIX: Smart Heartbeat
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    setInterval(() => {
        if (isProcessing || jobQueue.length > 0) {
            axios.get(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`).catch(() => {});
        } else {
            console.log("[System] Queue is empty. Allowing Railway idle timer to run...");
        }
    }, 120000); 
}
