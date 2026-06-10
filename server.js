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
    res.send("Multifunctional AI Video Worker is active! Supports: Shorts (subtitles + jump cuts) + Video Editing (mutes + timed overlays/GIFs). Send subtitles/keep_segments for shorts, or actions[] for editing. Both can be combined.");
});

// Robust download with retry for 423 (Cloudinary locks) and other transient errors
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
                console.log(`[Job ${jobId}] Cloudinary 423 lock - waiting ${waitMs / 1000}s before retry ${attempts}/${maxAttempts}...`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            if (attempts >= maxAttempts) {
                throw new Error(`Failed to download after ${maxAttempts} attempts: ${err.message}`);
            }
            console.log(`[Job ${jobId}] Download attempt ${attempts} failed (${err.message}). Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Subtitle rendering (from original shorts worker) - keeps the nice styling + emoji support
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
        console.log(`\n[Job ${jobId}] === STARTING NEW MULTIFUNCTIONAL RENDER ===`);
        console.log(`[Job ${jobId}] Downloading main video...`);
        await downloadFile(videoUrl, inputPath, jobId);

        let currentVideo = inputPath;

        // ========== PHASE 1: SUBTITLES (Shorts-style dynamic text burning) ==========
        const hasSubtitles = subtitles && Array.isArray(subtitles) && subtitles.length > 0;
        if (hasSubtitles) {
            console.log(`[Job ${jobId}] Phase 1: Compiling & burning subtitles...`);
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

            concatText += `file 'blank_${jobId}.png'\nduration 1.00\n`;
            fs.writeFileSync(concatTxtPath, concatText);

            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .input(concatTxtPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .complexFilter(['[0:v][1:v]overlay=x=0:y=0:eof_action=pass[outv]'], 'outv')
                    .outputOptions([
                        '-map 0:a',
                        '-c:a copy',
                        '-c:v libx264',
                        '-pix_fmt yuv420p',
                        '-preset fast'
                    ])
                    .save(burnedPath)
                    .on('end', resolve)
                    .on('error', reject);
            });

            currentVideo = burnedPath;
            console.log(`[Job ${jobId}] Subtitles burned successfully.`);
        } else {
            console.log(`[Job ${jobId}] Phase 1: Skipped (no subtitles).`);
        }

        // ========== PHASE 2: EDITOR ACTIONS (mute segments + timed image/GIF overlays) ==========
        let muteActions = [];
        let overlayActions = [];
        if (actions && Array.isArray(actions)) {
            muteActions = actions.filter(a => a.type === 'mute_title' || a.type === 'mute');
            overlayActions = actions.filter(a =>
                a.type === 'overlay_gif' || a.type === 'overlay_image' || a.type === 'overlay'
            );
        }
        const hasEditorActions = muteActions.length > 0 || overlayActions.length > 0;

        if (hasEditorActions) {
            console.log(`[Job ${jobId}] Phase 2: Applying ${muteActions.length} mute(s) + ${overlayActions.length} overlay(s)...`);

            // Download all overlay assets first
            for (let i = 0; i < overlayActions.length; i++) {
                const action = overlayActions[i];
                const assetUrl = action.url;
                const assetName = action.asset_name || `asset_${i}.png`;
                const ext = path.extname(assetName).toLowerCase() || '.png';

                if (assetUrl) {
                    const localAssetPath = path.join(__dirname, `asset_${jobId}_${i}${ext}`);
                    console.log(`[Job ${jobId}]   Downloading overlay asset ${i + 1}/${overlayActions.length}...`);
                    await downloadFile(assetUrl, localAssetPath, jobId);
                    action.localPath = localAssetPath;
                    action.isGif = ext === '.gif';
                    generatedFiles.push(localAssetPath);
                }
            }

            let command = ffmpeg(currentVideo);

            // Add overlay inputs (GIFs loop infinitely, images repeat single frame)
            overlayActions.forEach(action => {
                if (action.localPath) {
                    if (action.isGif) {
                        command.input(action.localPath).inputOptions(['-ignore_loop', '0']);
                    } else {
                        command.input(action.localPath).inputOptions(['-loop', '1']);
                    }
                }
            });

            let complexFilters = [];
            let outputOptions = [
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-c:a aac',
                '-preset fast',
                '-shortest'
            ];

            // Audio: timed muting (volume=0 on segments)
            if (muteActions.length > 0) {
                const volumeFilters = muteActions
                    .map(m => `volume=0:enable='between(t,${parseFloat(m.start_time)},${parseFloat(m.end_time)})'`)
                    .join(',');
                complexFilters.push(`[0:a]${volumeFilters}[outa]`);
                outputOptions.push('-map [outa]');
            } else {
                outputOptions.push('-map 0:a');
            }

            // Video: chained timed overlays (currently centered - easy to extend with x/y/position per action)
            if (overlayActions.length > 0) {
                let currentVidNode = '[0:v]';
                overlayActions.forEach((action, idx) => {
                    const nextVidNode = idx === overlayActions.length - 1 ? '[outv]' : `[v${idx + 1}]`;
                    const inputIdx = idx + 1;
                    const overlayExpr = `${currentVidNode}[${inputIdx}:v]overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${parseFloat(action.start_time)},${parseFloat(action.end_time)})'${nextVidNode}`;
                    complexFilters.push(overlayExpr);
                    currentVidNode = nextVidNode;
                });
                outputOptions.push('-map [outv]');
            } else {
                outputOptions.push('-map 0:v');
            }

            if (complexFilters.length > 0) {
                command.complexFilter(complexFilters);
            }

            command.outputOptions(outputOptions);

            await new Promise((resolve, reject) => {
                command.save(actionsPath)
                    .on('end', () => {
                        console.log(`[Job ${jobId}] Editor actions applied successfully.`);
                        currentVideo = actionsPath;
                        resolve();
                    })
                    .on('error', (err, stdout, stderr) => {
                        console.error(`[Job ${jobId}] FFmpeg actions error:`, err.message);
                        if (stderr) console.error('FFmpeg stderr:\n', stderr);
                        reject(err);
                    });
            });
        } else {
            console.log(`[Job ${jobId}] Phase 2: Skipped (no editor actions).`);
        }

        // ========== PHASE 3: PRECISION JUMP CUTS (keep_segments) ==========
        const hasCuts = keep_segments && Array.isArray(keep_segments) && keep_segments.length > 0;

        if (hasCuts) {
            console.log(`[Job ${jobId}] Phase 3: Performing ${keep_segments.length} precision jump cut(s)...`);

            let filterComplex = '';
            let concatInputs = '';

            for (let i = 0; i < keep_segments.length; i++) {
                const seg = keep_segments[i];
                const start = parseFloat(seg.start);
                const end = parseFloat(seg.end);
                filterComplex += `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]; `;
                filterComplex += `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]; `;
                concatInputs += `[v${i}][a${i}]`;
            }
            filterComplex += `${concatInputs}concat=n=${keep_segments.length}:v=1:a=1[outv][outa]`;

            await new Promise((resolve, reject) => {
                ffmpeg(currentVideo)
                    .complexFilter(filterComplex, ['outv', 'outa'])
                    .outputOptions([
                        '-c:v libx264',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        '-preset fast'
                    ])
                    .save(finalPath)
                    .on('end', () => {
                        console.log(`[Job ${jobId}] Jump cuts done. Sending final video...`);
                        res.download(finalPath, `final_video_${jobId}.mp4`, (err) => {
                            if (err) console.error(`[Job ${jobId}] Download error:`, err.message);
                            resolve();
                        });
                    })
                    .on('error', reject);
            });
        } else {
            console.log(`[Job ${jobId}] Phase 3: No cuts requested. Sending processed video...`);

            // Determine which file to send based on what processing happened
            let fileToSend;
            if (hasEditorActions) {
                fileToSend = actionsPath;
            } else if (hasSubtitles) {
                fileToSend = burnedPath;
            } else {
                fileToSend = inputPath;
            }

            await new Promise((resolve) => {
                res.download(fileToSend, `final_video_${jobId}.mp4`, (err) => {
                    if (err) console.error(`[Job ${jobId}] Download error:`, err.message);
                    resolve();
                });
            });
        }

    } catch (error) {
        console.error(`[Job ${jobId}] Critical error:`, error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Processing failed', details: error.message });
        }
    } finally {
        console.log(`[Job ${jobId}] Cleaning up temporary files...`);
        generatedFiles.forEach(file => {
            try {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            } catch (e) {}
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Multifunctional Video Worker listening on port ${PORT}`);
    console.log('Ready for shorts (subtitles + cuts) and/or advanced editing (mutes + overlays).');
});
