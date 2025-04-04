const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const process = require("process");

// --- Configuration (Mostly constants now) ---
const MINECRAFT_VERSION = "1.21"; // For optional mc-data
const MAX_RAYCAST_DISTANCE_BLOCKS = 25.5; // For display consistency
const MAX_RAYCAST_DISTANCE_UNITS = 255;
const MAX_REL_HEIGHT = 10.0; // Used for de-normalizing relative height display
const PLAYBACK_SPEED_MS = 50;
const CELL_SIZE_PX = 10; // Size of each cell drawn on the canvas
const REWIND_FF_FRAMES = 20; // Number of frames to jump for RW/FF

// --- Binary Format Constants ---
const MAGIC_STRING = "PKDSEQ";
const EXPECTED_VERSION = 1;
const HEADER_SIZE = 20;

// --- Load Minecraft Data (Optional) ---
let mcData;
try {
  mcData = require("minecraft-data")(MINECRAFT_VERSION);
  console.log(`Loaded MC data ${mcData.version.minecraftVersion}`);
} catch (err) {
  console.warn(`Warning: Could not load mc-data for version ${MINECRAFT_VERSION}: ${err.message}`);
  mcData = null;
}

// --- Block State ID to Name Mapping ---
const stateIdToName = {
  0: "Default/Solid",
  1: "Ladder",
  2: "Vine",
  3: "Water",
  4: "Lava",
  5: "Slime Block",
  6: "Cobweb",
  7: "Soul Sand",
  8: "Ice",
  9: "Blue Ice",
  10: "Honey Block",
};

// --- Base Color Mapping (HEX) ---
const stateIdToBaseHexColor = {
  0: "#A0A0A0", // Default/Solid
  1: "#A0522D", // Ladder
  2: "#228B22", // Vine
  3: "#0000FF", // Water
  4: "#FF4500", // Lava
  5: "#7CFC00", // Slime Block
  6: "#FFFFFF", // Cobweb
  7: "#5C4033", // Soul Sand
  8: "#ADD8E6", // Ice
  9: "#4169E1", // Blue Ice
  10: "#FFD700", // Honey Block
  unknown: "#FF00FF", // Magenta for unknown
};

// --- Helper: HEX to HSL (Used once during setup) ---
function hexToHsl(hex) {
    hex = hex.startsWith('#') ? hex.slice(1) : hex;
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length !== 6) return { h: 0, s: 0, l: 50 }; // Default gray

    let r = parseInt(hex.substring(0, 2), 16) / 255;
    let g = parseInt(hex.substring(2, 4), 16) / 255;
    let b = parseInt(hex.substring(4, 6), 16) / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) { h = s = 0; }
    else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch(max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// --- Pre-calculate HSL Colors ---
const stateIdToHsl = {};
for (const id in stateIdToBaseHexColor) {
    stateIdToHsl[id] = hexToHsl(stateIdToBaseHexColor[id]);
}
console.log("Pre-calculated HSL colors.");

// --- Server Setup ---
const app = express();
const server = http.createServer(app);

// --- Command Line Argument Parsing ---
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("\nUsage: node viewer.js <path_to_processed_BINARY_file>\n"); // Updated usage
  process.exit(1);
}
const processedDataPath = path.resolve(args[0]);

// --- Load and Parse BINARY Data ---
let frameDataForFrontend = []; // Array of objects: { vision_dist: Array, vision_block_id: Array, proprio: Array, actions: Object }
let totalFrames = 0;
let visionWidth = 0;
let visionHeight = 0;
let sequenceLengthK = 0;

try {
  if (!fs.existsSync(processedDataPath)) {
    throw new Error(`Processed data file not found: ${processedDataPath}`);
  }

  const fileBuffer = fs.readFileSync(processedDataPath); // Read entire binary file
  console.log(`Read ${fileBuffer.length} bytes from ${processedDataPath}`);

  if (fileBuffer.length < HEADER_SIZE) {
    throw new Error("File too small to contain header.");
  }

  // 1. Read Header
  let offset = 0;
  const magic = fileBuffer.toString('ascii', offset, offset + MAGIC_STRING.length);
  offset += MAGIC_STRING.length;
  if (magic !== MAGIC_STRING) {
    throw new Error(`Invalid magic string. Expected ${MAGIC_STRING}, got ${magic}`);
  }

  const version = fileBuffer.readUInt8(offset); offset += 1;
  if (version !== EXPECTED_VERSION) {
    throw new Error(`Unsupported format version. Expected ${EXPECTED_VERSION}, got ${version}`);
  }

  visionWidth = fileBuffer.readUInt16BE(offset); offset += 2;
  visionHeight = fileBuffer.readUInt16BE(offset); offset += 2;
  sequenceLengthK = fileBuffer.readUInt8(offset); offset += 1;
  totalFrames = fileBuffer.readUInt32BE(offset); offset += 4; // Number of sequences = number of frames
  const reserved = fileBuffer.readUInt32BE(offset); offset += 4; // Read reserved bytes

  console.log(`Header Parsed: Version=${version}, Dim=${visionWidth}x${visionHeight}, K=${sequenceLengthK}, Frames=${totalFrames}`);

  if (visionWidth <= 0 || visionHeight <= 0 || sequenceLengthK <= 0 || totalFrames < 0) {
      throw new Error("Invalid header values (dimensions, K, or frame count).");
  }

  // 2. Calculate sizes
  const visionTickSize = visionWidth * visionHeight; // Bytes per grid per tick
  const visionSequenceSize = sequenceLengthK * visionTickSize; // Bytes per vision type per sequence
  const proprioTickSize = 8 * 4; // 8 floats * 4 bytes/float
  const proprioSequenceSize = sequenceLengthK * proprioTickSize;
  const actionSize = 1; // Byte
  const bytesPerSequence = visionSequenceSize + visionSequenceSize + proprioSequenceSize + actionSize;

  const expectedDataSize = totalFrames * bytesPerSequence;
  const actualDataSize = fileBuffer.length - HEADER_SIZE;

  if (actualDataSize !== expectedDataSize) {
      console.warn(`Warning: Expected data size ${expectedDataSize} bytes, but found ${actualDataSize} bytes. File might be truncated or corrupted.`);
      // Adjust totalFrames if file is smaller than expected
      if (actualDataSize < expectedDataSize && bytesPerSequence > 0) {
          totalFrames = Math.floor(actualDataSize / bytesPerSequence);
          console.warn(`Adjusted total frames to ${totalFrames} based on actual file size.`);
      } else if (bytesPerSequence <= 0) {
          totalFrames = 0; // Avoid division by zero
      }
  }


  // 3. Extract Frame Data (Vision + Last Tick Proprio + Actions)
  let currentOffset = HEADER_SIZE;
  for (let i = 0; i < totalFrames; i++) {
    const sequenceStartOffset = currentOffset;
    const lastTickIndex = sequenceLengthK - 1;

    // --- Vision Data (Last Tick) ---
    const distDataStart = sequenceStartOffset + (lastTickIndex * visionTickSize);
    const distDataEnd = distDataStart + visionTickSize;
    const blockIdDataStart = sequenceStartOffset + visionSequenceSize + (lastTickIndex * visionTickSize);
    const blockIdDataEnd = blockIdDataStart + visionTickSize;

    // Check bounds before slicing vision data
    if (distDataEnd > fileBuffer.length || blockIdDataEnd > fileBuffer.length) {
        console.warn(`Warning: Truncated data reading vision for frame ${i}. Stopping parse.`);
        totalFrames = i; // Adjust total frames to the last successfully read frame
        break;
    }
    const visionDistBuffer = fileBuffer.subarray(distDataStart, distDataEnd);
    const visionBlockIdBuffer = fileBuffer.subarray(blockIdDataStart, blockIdDataEnd);

    // --- Proprioceptive Data (Last Tick) ---
    const proprioDataStart = sequenceStartOffset + (2 * visionSequenceSize) + (lastTickIndex * proprioTickSize);
    const proprioDataEnd = proprioDataStart + proprioTickSize;
    const proprioTickData = [];
    if (proprioDataEnd <= fileBuffer.length) { // Check bounds before reading
        for (let p = 0; p < 8; p++) {
            proprioTickData.push(fileBuffer.readFloatBE(proprioDataStart + p * 4));
        }
    } else {
        console.warn(`Warning: Truncated data reading proprio for frame ${i}. Filling with zeros. Stopping parse.`);
        totalFrames = i; // Adjust total frames
        break; // Stop parsing further frames
    }


    // --- Action Data (Last Tick) ---
    const actionByteOffset = sequenceStartOffset + (2 * visionSequenceSize) + proprioSequenceSize;
    let actionByte = 0;
     if (actionByteOffset < fileBuffer.length) { // Check bounds
        actionByte = fileBuffer.readUInt8(actionByteOffset);
     } else {
         console.warn(`Warning: Truncated data reading action byte for frame ${i}. Stopping parse.`);
         totalFrames = i; // Adjust total frames
         break; // Stop parsing further frames
     }

    // Decode action byte into boolean flags
    const actions = {
        forward: (actionByte & (1 << 0)) !== 0,
        left:    (actionByte & (1 << 1)) !== 0,
        right:   (actionByte & (1 << 2)) !== 0,
        back:    (actionByte & (1 << 3)) !== 0,
        jump:    (actionByte & (1 << 4)) !== 0,
        sneak:   (actionByte & (1 << 5)) !== 0,
        sprint:  (actionByte & (1 << 6)) !== 0,
    };

    // Advance offset for the next sequence
    currentOffset += bytesPerSequence;

    // Store extracted data for the frontend
    frameDataForFrontend.push({
        vision_dist: Array.from(visionDistBuffer),
        vision_block_id: Array.from(visionBlockIdBuffer),
        proprio: proprioTickData, // Add proprio array
        actions: actions          // Add actions object
    });
  }
  console.log(`Successfully parsed data for ${frameDataForFrontend.length} frames.`);

} catch (err) {
    console.error(`Error loading or parsing binary data file:`, err);
    // Allow server to start but show error
    totalFrames = 0;
    frameDataForFrontend = [];
    // Reset dimensions if parsing failed after header read
    visionWidth = 0;
    visionHeight = 0;
}

// --- Generate and Serve HTML ---
app.get("/", (req, res) => {
  if (totalFrames === 0 && visionWidth === 0) { // Check if loading failed badly
    res.status(500).send("Error: Could not load or parse data file. Check server logs.");
    return;
  }

  const canvasWidth = visionWidth * CELL_SIZE_PX;
  const canvasHeight = visionHeight * CELL_SIZE_PX;

  // Stringify the extracted frame data for embedding
  let embeddedDataString;
  try {
      embeddedDataString = JSON.stringify(frameDataForFrontend);
  } catch (stringifyErr) {
      console.error("Error stringifying frame data for frontend:", stringifyErr);
      res.status(500).send("Error preparing data for visualization. Check server logs.");
      return;
  }


  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Parkour Data Playback (Enhanced)</title>
    <style>
        body { font-family: sans-serif; background-color: #282c34; color: #abb2bf; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
        h1 { margin-bottom: 15px; color: #61afef; }
        #container { display: flex; flex-direction: column; align-items: center; background-color: #3f4451; padding: 15px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); width: auto; max-width: 95vw; }
        #controls { margin-bottom: 15px; display: flex; flex-direction: column; gap: 5px; align-items: center; } /* Stack control rows */
        #playback-controls, #seek-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; } /* Allow wrapping within rows */
        #seek-controls input[type=number] { width: 70px; padding: 5px; background-color: #282c34; color: #abb2bf; border: 1px solid #5c6370; border-radius: 3px; }
        button { padding: 8px 15px; font-size: 14px; cursor: pointer; background-color: #61afef; color: #282c34; border: none; border-radius: 4px; transition: background-color 0.2s ease; }
        button:hover { background-color: #5295cc; }
        button:disabled { background-color: #5c6370; cursor: not-allowed; }
        #frame-info { font-size: 14px; color: #98c379; margin: 0 10px; } /* Add margin */
        #visualization-canvas { border: 1px solid #5c6370; background-color: #353a45; margin-bottom: 15px; image-rendering: pixelated; image-rendering: crisp-edges; display: block; /* Prevent extra space below */ margin-left: auto; margin-right: auto; /* Center canvas */ }
        #tooltip { position: absolute; background-color: rgba(40, 44, 52, 0.9); color: #abb2bf; padding: 5px 8px; border-radius: 4px; font-size: 12px; pointer-events: none; display: none; white-space: nowrap; z-index: 10; }
        #context-info {
            margin-top: 15px;
            padding: 10px;
            background-color: #2c313a;
            border: 1px solid #5c6370;
            border-radius: 5px;
            font-family: monospace; /* Good for fixed-width display */
            font-size: 13px;
            white-space: pre; /* Preserve whitespace for formatting */
            color: #c5c8c6; /* Lighter gray for context */
            min-width: 350px; /* Ensure some minimum width */
            max-width: 90%; /* Prevent excessive width */
            text-align: left;
            line-height: 1.4; /* Improve readability */
        }
        .context-label { color: #61afef; font-weight: bold; display: inline-block; min-width: 90px; } /* Blue labels, fixed width */
        .context-value { color: #98c379; } /* Green values */
        .context-bool-true { color: #98c379; font-weight: bold; } /* Green for true */
        .context-bool-false { color: #e06c75; } /* Reddish for false */
        .action-active { color: #e5c07b; font-weight: bold; } /* Yellow for active action */
        .action-inactive { color: #5c6370; } /* Dim inactive action */
    </style>
</head>
<body>
    <h1>Parkour Data Playback (Enhanced)</h1>
    <div id="container">
        <div id="controls">
             <div id="playback-controls">
                <button id="rewind-btn"><<</button>
                <button id="reset-btn">Reset</button>
                <button id="play-pause-btn">Play</button>
                <button id="ff-btn">>></button>
                <div id="frame-info">Frame: 0 / ${totalFrames > 0 ? totalFrames - 1 : 0}</div>
            </div>
            <div id="seek-controls">
                <label for="goto-frame-input">Go To:</label>
                <input type="number" id="goto-frame-input" min="0" max="${totalFrames > 0 ? totalFrames - 1 : 0}" value="0">
                <button id="goto-frame-btn">Go</button>
            </div>
        </div>
        <canvas id="visualization-canvas" width="${canvasWidth}" height="${canvasHeight}"></canvas>
        <div id="tooltip"></div>
        <!-- New Context Display Area -->
        <div id="context-info">Loading context...</div>
    </div>

    <script>
        // --- Embedded Data and Config ---
        const frameData = ${embeddedDataString}; // Now includes proprio and actions
        const totalFrames = ${totalFrames};
        const horizontalRays = ${visionWidth};
        const verticalRays = ${visionHeight};
        const maxDistanceBlocks = ${MAX_RAYCAST_DISTANCE_BLOCKS};
        const MAX_RAYCAST_DISTANCE_UNITS = ${MAX_RAYCAST_DISTANCE_UNITS};
        const MAX_REL_HEIGHT = ${MAX_REL_HEIGHT}; // Pass this for de-normalization
        const playbackSpeedMs = ${PLAYBACK_SPEED_MS};
        const stateIdToHsl = ${JSON.stringify(stateIdToHsl)};
        const stateIdToName = ${JSON.stringify(stateIdToName)};
        const CELL_SIZE = ${CELL_SIZE_PX};
        const REWIND_FF_FRAMES = ${REWIND_FF_FRAMES};

        // --- Constants for Shading (Unchanged) ---
        const MIN_LIGHTNESS_PERCENT = 0;
        const MAX_LIGHTNESS_PERCENT = 100;

        // --- DOM Elements ---
        const canvas = document.getElementById('visualization-canvas');
        const ctx = canvas.getContext('2d');
        const playPauseBtn = document.getElementById('play-pause-btn');
        const resetBtn = document.getElementById('reset-btn');
        const rewindBtn = document.getElementById('rewind-btn');
        const ffBtn = document.getElementById('ff-btn');
        const frameInfo = document.getElementById('frame-info');
        const tooltip = document.getElementById('tooltip');
        const contextInfoDiv = document.getElementById('context-info');
        const gotoFrameInput = document.getElementById('goto-frame-input');
        const gotoFrameBtn = document.getElementById('goto-frame-btn');

        // --- State Variables (Unchanged) ---
        let currentFrameIndex = 0;
        let isPlaying = false;
        let intervalId = null;

        // --- Helper Functions ---
        function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

        // --- Initialization ---
        function initialize() {
            // Add button listeners
            playPauseBtn.addEventListener('click', togglePlayPause);
            resetBtn.addEventListener('click', resetPlayback);
            rewindBtn.addEventListener('click', rewind);
            ffBtn.addEventListener('click', fastForward);
            gotoFrameBtn.addEventListener('click', gotoFrame);
            gotoFrameInput.addEventListener('keydown', (e) => {
                 if (e.key === 'Enter') {
                     e.preventDefault(); // Prevent potential form submission
                     gotoFrame();
                 }
            });

            // Canvas listeners (unchanged)
            canvas.addEventListener('mousemove', showTooltip);
            canvas.addEventListener('mouseleave', hideTooltip);

            // Display initial frame & context
            if (totalFrames > 0 && horizontalRays > 0 && verticalRays > 0) {
                updateDisplay(currentFrameIndex); // Use a combined update function
                playPauseBtn.disabled = false;
                resetBtn.disabled = false;
                rewindBtn.disabled = false;
                ffBtn.disabled = false;
                gotoFrameBtn.disabled = false;
                gotoFrameInput.disabled = false;
                gotoFrameInput.max = totalFrames - 1; // Set max attribute
            } else {
                 frameInfo.textContent = 'No data loaded or invalid dimensions.';
                 playPauseBtn.disabled = true; resetBtn.disabled = true; rewindBtn.disabled = true; ffBtn.disabled = true; gotoFrameBtn.disabled = true; gotoFrameInput.disabled = true;
                 contextInfoDiv.textContent = 'No data loaded.';
                 if (ctx) { ctx.fillStyle = '#FF0000'; ctx.font = '16px sans-serif'; ctx.fillText('Error loading data', 10, 20); }
            }
        }

        // --- Combined Update Function ---
        function updateDisplay(frameIndex) {
             if (frameIndex < 0 || frameIndex >= totalFrames) return; // Safety check
             currentFrameIndex = frameIndex; // Update state
             displayFrameOnCanvas(currentFrameIndex);
             displayContextInfo(currentFrameIndex);
             updateControlsState(currentFrameIndex); // Update frame counter, input value, button states
        }

        // --- Display Logic (Canvas - Renamed) ---
        function displayFrameOnCanvas(frameIndex) {
            if (!ctx || frameIndex < 0 || frameIndex >= totalFrames) { return; }
            const currentFrame = frameData[frameIndex];
            if (!currentFrame?.vision_dist || !currentFrame?.vision_block_id) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
            const tickDistData = currentFrame.vision_dist;
            const tickBlockIdData = currentFrame.vision_block_id;
            const expectedLength = verticalRays * horizontalRays;
            if (tickDistData.length !== expectedLength || tickBlockIdData.length !== expectedLength) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
            for (let v = 0; v < verticalRays; v++) {
                for (let h = 0; h < horizontalRays; h++) {
                    const flatIndex = v * horizontalRays + h;
                    const distanceValue = tickDistData[flatIndex] ?? MAX_RAYCAST_DISTANCE_UNITS;
                    const blockId = tickBlockIdData[flatIndex] ?? 0;
                    const baseHsl = stateIdToHsl[blockId] || stateIdToHsl['unknown'];
                    const clampedDistance = clamp(distanceValue, 0, MAX_RAYCAST_DISTANCE_UNITS);
                    const normalizedDistance = clampedDistance / MAX_RAYCAST_DISTANCE_UNITS;
                    const targetLightness = MIN_LIGHTNESS_PERCENT + normalizedDistance * (MAX_LIGHTNESS_PERCENT - MIN_LIGHTNESS_PERCENT);
                    ctx.fillStyle = \`hsl(\${baseHsl.h}, \${baseHsl.s}%, \${clamp(targetLightness, 0, 100)}%)\`;
                    ctx.fillRect(h * CELL_SIZE, v * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                }
            }
        }

        // --- Display Context Info ---
        function displayContextInfo(frameIndex) {
            if (frameIndex < 0 || frameIndex >= totalFrames) {
                contextInfoDiv.textContent = 'Invalid frame index.';
                return;
            }
            const currentFrame = frameData[frameIndex];
            if (!currentFrame || !currentFrame.proprio || !currentFrame.actions) {
                contextInfoDiv.textContent = 'Context data missing for this frame.';
                return;
            }

            const proprio = currentFrame.proprio; // [vx, vy, vz, relYawNorm, onG, colH, colV, relYNorm]
            const actions = currentFrame.actions; // {forward: bool, ...}

            // De-normalize values for display
            const relYawDeg = (proprio[3] * 180).toFixed(1);
            const relHeight = (proprio[7] * MAX_REL_HEIGHT).toFixed(2); // Use MAX_REL_HEIGHT

            // Helper to format boolean values with CSS classes
            const formatBool = (val) => \`<span class="context-bool-\${val ? 'true' : 'false'}">\${val ? 'True' : 'False'}</span>\`;
            // Helper to format action keys
            const formatAction = (key, isActive) => \`<span class="action-\${isActive ? 'active' : 'inactive'}">\${key.toUpperCase()}</span>\`;

            // Build HTML string line by line for better readability
            let contextHTML = '';
            contextHTML += \`<span class="context-label">Velocity:</span> <span class="context-value">(\${proprio[0].toFixed(3)}, \${proprio[1].toFixed(3)}, \${proprio[2].toFixed(3)})</span>\\n\`;
            contextHTML += \`<span class="context-label">Rel Yaw:</span> <span class="context-value">\${relYawDeg}°</span> \`;
            contextHTML += \`<span class="context-label">Rel Height:</span> <span class="context-value">\${relHeight}</span>\\n\`;
            contextHTML += \`<span class="context-label">On Ground:</span> \${formatBool(proprio[4] > 0.5)} \`;
            contextHTML += \`<span class="context-label">Collided H:</span> \${formatBool(proprio[5] > 0.5)} \`;
            contextHTML += \`<span class="context-label">Collided V:</span> \${formatBool(proprio[6] > 0.5)}\\n\`;
            contextHTML += \`<span class="context-label">Actions:</span> [ \`;
            contextHTML += \`\${formatAction('F', actions.forward)} \`;
            contextHTML += \`\${formatAction('L', actions.left)} \`;
            contextHTML += \`\${formatAction('R', actions.right)} \`;
            contextHTML += \`\${formatAction('B', actions.back)} \`;
            contextHTML += \`\${formatAction('J', actions.jump)} \`;
            contextHTML += \`\${formatAction('N', actions.sneak)} \`;
            contextHTML += \`\${formatAction('S', actions.sprint)} ]\`;

            contextInfoDiv.innerHTML = contextHTML; // Use innerHTML to render styled spans
        }

        // --- Update Controls State ---
        function updateControlsState(frameIndex) {
            frameInfo.textContent = \`Frame: \${frameIndex} / \${totalFrames - 1}\`;
            gotoFrameInput.value = frameIndex;
            // Disable buttons at boundaries
            rewindBtn.disabled = frameIndex <= 0;
            resetBtn.disabled = frameIndex <= 0;
            ffBtn.disabled = frameIndex >= totalFrames - 1;
            playPauseBtn.disabled = frameIndex >= totalFrames - 1 && !isPlaying; // Can pause if playing at end
            gotoFrameBtn.disabled = totalFrames <= 0; // Disable if no frames
            gotoFrameInput.disabled = totalFrames <= 0;
        }


        // --- Tooltip Logic ---
        function showTooltip(event) {
            if (totalFrames === 0) return;
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width; const scaleY = canvas.height / rect.height;
            const canvasX = (event.clientX - rect.left) * scaleX;
            const canvasY = (event.clientY - rect.top) * scaleY;
            const h = Math.floor(canvasX / CELL_SIZE);
            const v = Math.floor(canvasY / CELL_SIZE);

            if (h >= 0 && h < horizontalRays && v >= 0 && v < verticalRays) {
                const currentFrame = frameData[currentFrameIndex];
                 if (!currentFrame?.vision_dist || !currentFrame?.vision_block_id) {
                    hideTooltip(); return;
                 }
                const flatIndex = v * horizontalRays + h;
                const distanceValue = currentFrame.vision_dist[flatIndex] ?? MAX_RAYCAST_DISTANCE_UNITS;
                const blockId = currentFrame.vision_block_id[flatIndex] ?? 0;
                const distance = (distanceValue / 10).toFixed(1);
                const blockName = stateIdToName[blockId] || 'Unknown';

                tooltip.textContent = \`[H:\${h}, V:\${v}] Dist: \${distance}b, Type: \${blockName} (ID:\${blockId})\`;
                tooltip.style.display = 'block';

                // Position tooltip (same logic)
                const xOffset = 15; const yOffset = 10; let x = event.clientX + xOffset; let y = event.clientY + yOffset; const tooltipRect = tooltip.getBoundingClientRect(); if (x + tooltipRect.width > window.innerWidth) x = event.clientX - tooltipRect.width - xOffset; if (y + tooltipRect.height > window.innerHeight) y = event.clientY - tooltipRect.height - yOffset; tooltip.style.left = \`\${x}px\`; tooltip.style.top = \`\${y}px\`;
            } else {
                hideTooltip();
            }
        }
        function hideTooltip() { tooltip.style.display = 'none'; }


        // --- Playback Controls ---
        function togglePlayPause() { if (isPlaying) pausePlayback(); else startPlayback(); }

        function startPlayback() {
             if (isPlaying || totalFrames === 0 || horizontalRays === 0 || verticalRays === 0) return;
             if (currentFrameIndex >= totalFrames - 1) {
                 resetPlayback(); // Reset if trying to play from the end
             }
             isPlaying = true;
             playPauseBtn.textContent = 'Pause';
             playPauseBtn.disabled = false; // Ensure pause is enabled
             intervalId = setInterval(() => {
                 let nextFrame = currentFrameIndex + 1;
                 if (nextFrame >= totalFrames) {
                     nextFrame = totalFrames - 1;
                     pausePlayback(); // Pause when reaching the end
                     updateDisplay(nextFrame); // Ensure last frame is displayed correctly
                 } else {
                     updateDisplay(nextFrame); // Update canvas, context, and controls
                 }
             }, playbackSpeedMs);
         }
        function pausePlayback() {
             if (!isPlaying) return;
             isPlaying = false;
             playPauseBtn.textContent = 'Play';
             clearInterval(intervalId);
             intervalId = null;
             updateControlsState(currentFrameIndex); // Update button states after pausing
         }

        function resetPlayback() {
             pausePlayback(); // Stop playback if running
             updateDisplay(0); // Go to frame 0 and update everything
         }

        // --- Rewind/FF/GoTo ---
        function rewind() {
            pausePlayback(); // Stop if playing
            const targetFrame = Math.max(0, currentFrameIndex - REWIND_FF_FRAMES);
            updateDisplay(targetFrame);
        }

        function fastForward() {
            pausePlayback(); // Stop if playing
            const targetFrame = Math.min(totalFrames - 1, currentFrameIndex + REWIND_FF_FRAMES);
            updateDisplay(targetFrame);
        }

        function gotoFrame() {
            pausePlayback(); // Stop if playing
            const targetFrame = parseInt(gotoFrameInput.value, 10);
            if (!isNaN(targetFrame)) {
                const clampedFrame = clamp(targetFrame, 0, totalFrames - 1);
                updateDisplay(clampedFrame);
            } else {
                // Handle invalid input, reset input to current frame
                gotoFrameInput.value = currentFrameIndex;
            }
        }


        // --- Start ---
        document.addEventListener('DOMContentLoaded', initialize);

    </script>
</body>
</html>
`;
  res.setHeader("Content-Type", "text/html");
  res.send(htmlContent);
});

// --- Start Server ---
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\nVisualization server running.`);
  console.log(`Data file: ${processedDataPath}`);
  if (visionWidth > 0 && visionHeight > 0) {
    console.log(`Detected Dimensions: ${visionWidth} x ${visionHeight}`);
    console.log(`Open http://localhost:${PORT} in your browser.\n`);
  } else if (totalFrames > 0) { // totalFrames might be > 0 even if dimensions are 0 if header parsing failed later
    console.error(`\nError: Could not determine dimensions from data or data parsing failed. Visualization might not work.`);
    console.error(`Please check the data file: ${processedDataPath} and server logs.\n`);
  } else { // No frames loaded, likely due to error or empty file
    console.warn(`\nWarning: No data loaded or error during load. Server started but visualization will be empty.`);
    console.warn(`Open http://localhost:${PORT} in your browser.\n`);
  }
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`Error: Port ${PORT} is already in use.`);
  else console.error("Server error:", err);
  process.exit(1);
});