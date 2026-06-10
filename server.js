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
    res.send("Multifunctional AI Video Worker v2 is active! Supports Shorts + Smart Video Editing with per-asset scaling.");
});

// Robust download with retry for 423 (Cloudinary) and other errors
async function downloadFile(url, dest, jobId = '') {
    let attempts = 0;
    const maxAttempts = 6;

    while (attempts < maxAttempts) {
        try {
            const response = await axios({
                url,
                responseType: 'stream',
                timeout: 90000,
                maxRedirects: 5
            });
            const writer = fs.createWriteStream(dest);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            return;
        } catch (err) {
            attempts++;
            const status = err.response?.status;

            if (status === 423 && attempts < maxAttempts) {
                const waitMs = attempts * 4500;
                console.log(`[Job ${jobId}] Cloudinary 423 lock - retrying in ${waitMs / 1000}s...`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            if (attempts >= maxAttempts) {
                throw new Error(`Download failed after ${maxAttempts} attempts: ${err.message}`);
            }
            console.log(`[Job ${jobId}] Download attempt ${attempts} failed. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Subtitle rendering with emoji support (optimized for Shorts)
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

            ctx.fillStyle = isUpper ? '#FFD700' : 'white';
            ctx.strokeStyle = 'black';
            ctx.font = isUpper ? 'bold 90px Roboto' : 'bold 80px Roboto';
            ctx.lineWidth = 8;

            ctx.strokeText(char, currentCursorX, 1480);
            ctx.fillText(char, currentCursorX, 1480);
            currentCursorX += ctx.measureText(char).width;
        }
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
            const emojiX = cleanText.length > 0 ? finalCursorX + spacing : startX;
            ctx.drawImage(image, emojiX, 1480 - (emojiSize / 2), emojiSize, emojiSize);
        } catch (err) {
            console.error(`[Warning] Could not load emoji: ${twemojiUrl}`);
        }
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
        console.log(`\n[Job ${jobId}] === STARTING NEW RENDER ===`);
        await downloadFile(videoUrl, inputPath, jobId);
        let currentVideo = inputPath;

        // ========== PHASE 1: SUBTITLES ==========
        const hasSubtitles = subtitles && Array.isArray(subtitles) && subtitles.length > 0;
        if (hasSubtitles) {
            console.log(`[Job ${jobId}] Phase 1: Burning subtitles...`);
            await renderSubtitleImage("", blankPath);
            let concatText = "ffconcat version 1.0\n";
            let currentTime = 0;

            for (let i = 0; i < subtitles.length; i++) {
                const sub = subtitles[i];
                const start = parseFloat(sub.start);
                const end = parseFloat(sub.end);

                if (start > currentTime) {
                    concatText += `file 'blank_${jobId}.png'\nduration ${(start - currentTime).toFixed(2)}\n`;
                }
                const imgName = `sub_${jobId}_${i}.png`;
                const imgPath = path.join(__dirname, imgName);
                await renderSubtitleImage(sub.text, imgPath);
                generatedFiles.push(imgPath);

                concatText += `file '${imgName}'\nduration ${(end - start).toFixed(2)}\n`;
                currentTime = end;
            }
            concatText += `file 'blank_${jobId}.png'\nduration 1.00\n`;
            fs.writeFileSync(concatTxtPath, concatText);

            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .input(concatTxtPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .complexFilter(['[0:v][1:v]overlay=x=0:y=0:eof_action=pass[outv]'], 'outv')
                    .outputOptions(['-map 0:a', '-c:a copy', '-c:v libx264', '-pix_fmt yuv420p', '-preset fast'])
                    .save(burnedPath)
                    .on('end', resolve)
                    .on('error', reject);
            });
            currentVideo = burnedPath;
        }

        // ========== PHASE 2: EDITOR ACTIONS (with smart per-asset scaling) ==========
        let muteActions = [];
        let overlayActions = [];
        if (actions && Array.isArray(actions)) {
            muteActions = actions.filter(a => ['mute_title', 'mute'].includes(a.type));
            overlayActions = actions.filter(a => ['overlay_gif', 'overlay_image', 'overlay'].includes(a.type));
        }
        const hasEditorActions = muteActions.length > 0 || overlayActions.length > 0;

        if (hasEditorActions) {
            console.log(`[Job ${jobId}] Phase 2: Applying ${muteActions.length} mute(s) + ${overlayActions.length} overlay(s)...`);

            // Download assets
            for (let i = 0; i < overlayActions.length; i++) {
                const action = overlayActions[i];
                if (action.url) {
                    const ext = path.extname(action.asset_name || '').toLowerCase() || '.png';
                    const localPath = path.join(__dirname, `asset_${jobId}_${i}${ext}`);
                    await downloadFile(action.url, localPath, jobId);
                    action.localPath = localPath;
                    action.isGif = ext === '.gif';
                    generatedFiles.push(localPath);
                }
            }

            let command = ffmpeg(currentVideo);

            overlayActions.forEach(action => {
                if (action.localPath) {
                    const opts = action.isGif ? ['-ignore_loop', '0'] : ['-loop', '1'];
                    command.input(action.localPath).inputOptions(opts);
                }
            });

            let complexFilters = [];
            let outputOptions = ['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-preset fast', '-shortest'];

            // Audio muting
            if (muteActions.length > 0) {
                const volumeFilters = muteActions.map(m =>
                    `volume=0:enable='between(t,${parseFloat(m.start_time)},${parseFloat(m.end_time)})'`
                ).join(',');
                complexFilters.push(`[0:a]${volumeFilters}[outa]`);
                outputOptions.push('-map [outa]');
            } else {
                outputOptions.push('-map 0:a');
            }

            // Video overlays with smart scaling
            if (overlayActions.length > 0) {
                let currentVidNode = '[0:v]';

                overlayActions.forEach((action, idx) => {
                    const nextVidNode = idx === overlayActions.length - 1 ? '[outv]' : `[v${idx + 1}]`;
                    const inputIdx = idx + 1;
                    const scaledNode = `[scaled_v${idx + 1}]`;

                    // Per-overlay size control (defaults to 800x800)
                    const MAX_W = parseInt(action.max_width) || 800;
                    const MAX_H = parseInt(action.max_height) || 800;

                    // Smart scale (never upscale small assets)
                    complexFilters.push(
                        `[${inputIdx}:v]scale='min(${MAX_W},iw):min(${MAX_H},ih):force_original_aspect_ratio=decrease'${scaledNode}`
                    );

                    // Overlay centered
                    complexFilters.push(
                        `${currentVidNode}${scaledNode}overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${parseFloat(action.start_time)},${parseFloat(action.end_time)})'${nextVidNode}`
                    );

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
                    .on('end', () => {
                        currentVideo = actionsPath;
                        resolve();
                    })
                    .on('error', reject);
            });
        }

        // ========== PHASE 3: JUMP CUTS ==========
        const hasCuts = keep_segments && Array.isArray(keep_segments) && keep_segments.length > 0;

        if (hasCuts) {
            console.log(`[Job ${jobId}] Phase 3: Performing jump cuts...`);
            let filterComplex = '';
            let concatInputs = '';

            keep_segments.forEach((seg, i) => {
                const start = parseFloat(seg.start);
                const end = parseFloat(seg.end);
                filterComplex += `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]; `;
                filterComplex += `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]; `;
                concatInputs += `[v${i}][a${i}]`;
            });
            filterComplex += `${concatInputs}concat=n=${keep_segments.length}:v=1:a=1[outv][outa]`;

            await new Promise((resolve, reject) => {
                ffmpeg(currentVideo)
                    .complexFilter(filterComplex, ['outv', 'outa'])
                    .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-preset fast'])
                    .save(finalPath)
                    .on('end', () => {
                        res.download(finalPath, `final_video_${jobId}.mp4`, resolve);
                    })
                    .on('error', reject);
            });
        } else {
            const fileToSend = hasEditorActions ? actionsPath : (hasSubtitles ? burnedPath : inputPath);
            await new Promise((resolve) => {
                res.download(fileToSend, `final_video_${jobId}.mp4`, resolve);
            });
        }

    } catch (error) {
        console.error(`[Job ${jobId}] Error:`, error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Processing failed', details: error.message });
    } finally {
        generatedFiles.forEach(file => {
            try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker running on port ${PORT}`));
