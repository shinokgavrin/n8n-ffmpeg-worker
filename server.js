const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createCanvas, loadImage } = require('canvas');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/debug', (req, res) => {
    res.send("Multifunctional AI Video Worker v3 (RAM-Optimized) is active!");
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

app.post('/render', async (req, res) => {
    const { videoUrl, subtitles, keep_segments, actions } = req.body;
    const jobId = randomUUID();
    const inputPath = path.join(__dirname, `input_${jobId}.mp4`);
    const burnedPath = path.join(__dirname, `burned_${jobId}.mp4`);
    const actionsPath = path.join(__dirname, `actions_${jobId}.mp4`);
    const finalPath = path.join(__dirname, `final_${jobId}.mp4`);
    const concatTxtPath = path.join(__dirname, `concat_${jobId}.txt`);
    const blankPath = path.join(__dirname, `blank_${jobId}.png`);
    let generatedFiles = [inputPath, burnedPath, actionsPath, finalPath, concatTxtPath, blankPath];

    try {
        console.log(`\n[Job ${jobId}] === STARTING RAM-OPTIMIZED RENDER ===`);
        await downloadFile(videoUrl, inputPath, jobId);
        let currentVideo = inputPath;

        // ========== PHASE 1: SUBTITLES ==========
        const hasSubtitles = subtitles && Array.isArray(subtitles) && subtitles.length > 0;
        if (hasSubtitles) {
            console.log(`[Job ${jobId}] Phase 1: Burning subtitles...`);
            await renderSubtitleImage("", blankPath);
            let concatText = "ffconcat version 1.0\n", currentTime = 0;
            for (let i = 0; i < subtitles.length; i++) {
                const sub = subtitles[i], start = parseFloat(sub.start), end = parseFloat(sub.end);
                if (start > currentTime) concatText += `file 'blank_${jobId}.png'\nduration ${(start - currentTime).toFixed(2)}\n`;
                const imgName = `sub_${jobId}_${i}.png`, imgPath = path.join(__dirname, imgName);
                await renderSubtitleImage(sub.text, imgPath);
                generatedFiles.push(imgPath);
                concatText += `file '${imgName}'\nduration ${(end - start).toFixed(2)}\n`;
                currentTime = end;
            }
            concatText += `file 'blank_${jobId}.png'\nduration 1.00\n`;
            fs.writeFileSync(concatTxtPath, concatText);

            await new Promise((resolve, reject) => {
                ffmpeg(inputPath).input(concatTxtPath).inputOptions(['-f', 'concat', '-safe', '0'])
                    .complexFilter(['[0:v][1:v]overlay=x=0:y=0:eof_action=pass[outv]'], 'outv')
                    .outputOptions(['-map 0:a', '-c:a copy', '-c:v libx264', '-pix_fmt yuv420p', '-preset fast'])
                    .save(burnedPath).on('end', resolve).on('error', reject);
            });
            currentVideo = burnedPath;
        }

        // ========== PHASE 2: EDITOR ACTIONS (RAM SAVER MODE) ==========
        let muteActions = [], overlayActions = [];
        if (actions && Array.isArray(actions)) {
            muteActions = actions.filter(a => ['mute_title', 'mute'].includes(a.type));
            overlayActions = actions.filter(a => ['overlay_gif', 'overlay_image', 'overlay'].includes(a.type));
        }
        const hasEditorActions = muteActions.length > 0 || overlayActions.length > 0;

        if (hasEditorActions) {
            console.log(`[Job ${jobId}] Phase 2: Processing ${overlayActions.length} assets with RAM Optimization...`);

            for (let i = 0; i < overlayActions.length; i++) {
                if (overlayActions[i].url) {
                    const ext = path.extname(overlayActions[i].asset_name || '').toLowerCase() || '.png';
                    const localPath = path.join(__dirname, `asset_${jobId}_${i}${ext}`);
                    await downloadFile(overlayActions[i].url, localPath, jobId);
                    overlayActions[i].localPath = localPath;
                    overlayActions[i].isGif = ext === '.gif';
                    generatedFiles.push(localPath);
                }
            }

            // УВЕЛИЧИВАЕМ ШИНУ ДАННЫХ ДЛЯ ОСНОВНОГО ВИДЕО
            let command = ffmpeg(currentVideo).inputOptions(['-thread_queue_size', '1024']);

            overlayActions.forEach(action => {
                if (action.localPath) {
                    // УВЕЛИЧИВАЕМ ШИНУ ДАННЫХ ДЛЯ КАЖДОГО АССЕТА
                    let inputOpts = ['-thread_queue_size', '512'];
                    inputOpts.push(action.isGif ? '-ignore_loop' : '-loop', action.isGif ? '0' : '1');
                    
                    // RAM SAVER: Генерируем только нужные секунды! (конец - начало + 0.5 сек запаса)
                    const duration = parseFloat(action.end_time) - parseFloat(action.start_time);
                    inputOpts.push('-t', (duration + 0.5).toFixed(2));
                    
                    command.input(action.localPath).inputOptions(inputOpts);
                }
            });

            let complexFilters = [];
            let outputOptions = ['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-preset fast', '-shortest'];

            if (muteActions.length > 0) {
                const volumeFilters = muteActions.map(m => `volume=0:enable='between(t,${parseFloat(m.start_time)},${parseFloat(m.end_time)})'`).join(',');
                complexFilters.push(`[0:a]${volumeFilters}[outa]`);
                outputOptions.push('-map [outa]');
            } else {
                outputOptions.push('-map 0:a');
            }

            if (overlayActions.length > 0) {
                let currentVidNode = '[0:v]';
                overlayActions.forEach((action, idx) => {
                    const nextVidNode = idx === overlayActions.length - 1 ? '[outv]' : `[v${idx + 1}]`;
                    const inputIdx = idx + 1, scaledNode = `[scaled_v${idx + 1}]`;
                    const MAX_W = parseInt(action.max_width) || 800, MAX_H = parseInt(action.max_height) || 800;
                    const startTime = parseFloat(action.start_time), endTime = parseFloat(action.end_time);

                    // Сдвигаем короткий сгенерированный отрезок на правильное время (setpts) и масштабируем
                    complexFilters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS+${startTime}/TB,scale='min(${MAX_W},iw):min(${MAX_H},ih):force_original_aspect_ratio=decrease'${scaledNode}`);
                    
                    // Накладываем по центру. eof_action=pass критически важен, чтобы видео не оборвалось, когда кончится гифка!
                    complexFilters.push(`${currentVidNode}${scaledNode}overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${startTime},${endTime})':eof_action=pass${nextVidNode}`);
                    
                    currentVidNode = nextVidNode;
                });
                outputOptions.push('-map [outv]');
            } else {
                outputOptions.push('-map 0:v');
            }

            if (complexFilters.length > 0) command.complexFilter(complexFilters);
            command.outputOptions(outputOptions);

            await new Promise((resolve, reject) => {
                command.save(actionsPath)
                    .on('end', () => { currentVideo = actionsPath; resolve(); })
                    .on('error', (err, stdout, stderr) => {
                        console.error(`[Job ${jobId}] FFmpeg actions error:`, err.message);
                        if (stderr) console.error('FFmpeg stderr:\n', stderr);
                        reject(err);
                    });
            });
        }

        // ========== PHASE 3: JUMP CUTS ==========
        const hasCuts = keep_segments && Array.isArray(keep_segments) && keep_segments.length > 0;
        if (hasCuts) {
            console.log(`[Job ${jobId}] Phase 3: Performing jump cuts...`);
            let filterComplex = '', concatInputs = '';
            keep_segments.forEach((seg, i) => {
                const start = parseFloat(seg.start), end = parseFloat(seg.end);
                filterComplex += `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]; `;
                filterComplex += `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]; `;
                concatInputs += `[v${i}][a${i}]`;
            });
            filterComplex += `${concatInputs}concat=n=${keep_segments.length}:v=1:a=1[outv][outa]`;

            await new Promise((resolve, reject) => {
                ffmpeg(currentVideo).complexFilter(filterComplex, ['outv', 'outa'])
                    .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-preset fast'])
                    .save(finalPath).on('end', () => res.download(finalPath, `final_video_${jobId}.mp4`, resolve)).on('error', reject);
            });
        } else {
            const fileToSend = hasEditorActions ? actionsPath : (hasSubtitles ? burnedPath : inputPath);
            await new Promise((resolve) => res.download(fileToSend, `final_video_${jobId}.mp4`, resolve));
        }

    } catch (error) {
        console.error(`[Job ${jobId}] Error:`, error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Processing failed', details: error.message });
    } finally {
        generatedFiles.forEach(file => { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {} });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAM-Optimized Worker running on port ${PORT}`));
