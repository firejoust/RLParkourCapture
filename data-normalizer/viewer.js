const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const process = require("process"); // To access command line arguments

// --- Configuration ---
const MINECRAFT_VERSION = "1.21";
const MAX_RAYCAST_DISTANCE_BLOCKS = 25.5;
const MAX_RAYCAST_DISTANCE_UNITS = 255;
const PLAYBACK_SPEED_MS = 50; // ~20 FPS playback
const CELL_SIZE_PX = 10; // Size of each cell drawn on the canvas

// --- Load Minecraft Data (Optional) ---
// (Keep the existing mcData loading block - unchanged)
let mcData;
try {
  mcData = require("minecraft-data")(MINECRAFT_VERSION);
  console.log(`Loaded Minecraft data version: ${mcData.version.minecraftVersion}`);
} catch (err) {
  console.warn(`Warning: Could not load minecraft-data for version ${MINECRAFT_VERSION}. Block names in tooltips might be less accurate if raw IDs were used. Error: ${err.message}`);
  mcData = null;
}


// --- Block State ID to Name Mapping (Unchanged) ---
const stateIdToName = {
  0: "Default/Solid", 1: "Ladder", 2: "Vine", 3: "Water", 4: "Lava",
  5: "Slime Block", 6: "Cobweb", 7: "Soul Sand", 8: "Ice", 9: "Blue Ice",
  10: "Honey Block",
};

// --- Base Color Mapping (HEX - Unchanged) ---
const stateIdToBaseHexColor = {
  0: "#A0A0A0", 1: "#A0522D", 2: "#228B22", 3: "#0000FF", 4: "#FF4500",
  5: "#7CFC00", 6: "#FFFFFF", 7: "#5C4033", 8: "#ADD8E6", 9: "#4169E1",
  10: "#FFD700", unknown: "#FF00FF",
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

// --- Command Line Argument Parsing (Unchanged) ---
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("\nUsage: node server.js <path_to_processed_json_file>\n");
  process.exit(1);
}
const processedDataPath = path.resolve(args[0]);

// --- Load Processed Data & Infer Dimensions (Unchanged) ---
let allSequences = [];
let totalFrames = 0;
let inferredVisionWidth = 0;
let inferredVisionHeight = 0;
let inferredK = 4;

try {
  // (Keep the existing data loading and dimension inference logic - unchanged)
  if (!fs.existsSync(processedDataPath)) throw new Error(`File not found: ${processedDataPath}`);
  const fileContent = fs.readFileSync(processedDataPath, "utf8");
  allSequences = JSON.parse(fileContent);
  totalFrames = allSequences.length;
  console.log(`Loaded ${totalFrames} sequences/frames from ${processedDataPath}`);
  if (totalFrames > 0) {
    const firstSequence = allSequences[0];
    if (firstSequence?.vision_dist_seq?.[0]?.[0]) {
        inferredK = firstSequence.vision_dist_seq.length;
        const firstFrameVisionData = firstSequence.vision_dist_seq[inferredK - 1];
        inferredVisionHeight = firstFrameVisionData.length;
        inferredVisionWidth = firstFrameVisionData[0].length;
        console.log(`Inferred K: ${inferredK}, Dimensions: ${inferredVisionWidth} x ${inferredVisionHeight}`);
        if (firstSequence.proprio_seq?.[0]?.length !== 8) {
            console.warn(`Warning: Expected 8 elements in proprio_seq, found ${firstSequence.proprio_seq?.[0]?.length}.`);
        }
    } else { throw new Error("Malformed data: Cannot infer dimensions."); }
  } else { console.warn("Warning: 0 sequences loaded."); }
} catch (err) {
  console.error(`Error loading/parsing data:`, err);
  process.exit(1);
}

// --- Generate and Serve HTML ---
app.get("/", (req, res) => {
  if (totalFrames > 0 && (inferredVisionWidth === 0 || inferredVisionHeight === 0)) {
    res.status(500).send("Error: Could not determine vision grid dimensions from data.");
    return;
  }

  // Calculate canvas dimensions based on inferred grid and cell size
  const canvasWidth = inferredVisionWidth * CELL_SIZE_PX;
  const canvasHeight = inferredVisionHeight * CELL_SIZE_PX;

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Parkour Data Playback (Canvas)</title>
    <style>
        body { font-family: sans-serif; background-color: #282c34; color: #abb2bf; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
        h1 { margin-bottom: 15px; color: #61afef; }
        #container { display: flex; flex-direction: column; align-items: center; background-color: #3f4451; padding: 15px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
        #controls { margin-bottom: 15px; display: flex; gap: 10px; align-items: center; }
        button { padding: 8px 15px; font-size: 14px; cursor: pointer; background-color: #61afef; color: #282c34; border: none; border-radius: 4px; transition: background-color 0.2s ease; }
        button:hover { background-color: #5295cc; }
        button:disabled { background-color: #5c6370; cursor: not-allowed; }
        #frame-info { font-size: 14px; color: #98c379; }
        /* Style the canvas */
        #visualization-canvas {
            border: 1px solid #5c6370;
            background-color: #353a45; /* Background if cells don't cover */
            margin-bottom: 15px;
            /* Set display size via style if needed, but width/height attributes control resolution */
            /* width: ${canvasWidth}px; */
            /* height: ${canvasHeight}px; */
            image-rendering: pixelated; /* Keep pixels sharp */
            image-rendering: crisp-edges;
        }
        #tooltip { position: absolute; background-color: rgba(40, 44, 52, 0.9); color: #abb2bf; padding: 5px 8px; border-radius: 4px; font-size: 12px; pointer-events: none; display: none; white-space: nowrap; z-index: 10; }
    </style>
</head>
<body>
    <h1>Parkour Data Playback (Canvas)</h1>
    <div id="container">
        <div id="controls">
            <button id="reset-btn">Reset</button>
            <button id="play-pause-btn">Play</button>
            <div id="frame-info">Frame: 0 / ${totalFrames > 0 ? totalFrames - 1 : 0}</div>
        </div>
        <!-- Canvas Element -->
        <canvas id="visualization-canvas" width="${canvasWidth}" height="${canvasHeight}"></canvas>
        <div id="tooltip"></div>
    </div>

    <script>
        // --- Embedded Data and Config ---
        const allSequences = ${JSON.stringify(allSequences)};
        const totalFrames = ${totalFrames};
        const horizontalRays = ${inferredVisionWidth};
        const verticalRays = ${inferredVisionHeight};
        const K = ${inferredK};
        const maxDistanceBlocks = ${MAX_RAYCAST_DISTANCE_BLOCKS};
        const MAX_RAYCAST_DISTANCE_UNITS = ${MAX_RAYCAST_DISTANCE_UNITS};
        const playbackSpeedMs = ${PLAYBACK_SPEED_MS};
        // Use pre-calculated HSL colors
        const stateIdToHsl = ${JSON.stringify(stateIdToHsl)};
        const stateIdToName = ${JSON.stringify(stateIdToName)};
        const CELL_SIZE = ${CELL_SIZE_PX}; // Cell size in pixels

        // --- Constants for Shading ---
        const MIN_LIGHTNESS_PERCENT = 0;
        const MAX_LIGHTNESS_PERCENT = 100;

        // --- DOM Elements ---
        const canvas = document.getElementById('visualization-canvas');
        const ctx = canvas.getContext('2d'); // Get 2D rendering context
        const playPauseBtn = document.getElementById('play-pause-btn');
        const resetBtn = document.getElementById('reset-btn');
        const frameInfo = document.getElementById('frame-info');
        const tooltip = document.getElementById('tooltip');

        // --- State Variables ---
        let currentFrameIndex = 0;
        let isPlaying = false;
        let intervalId = null;
        // No gridCells array needed anymore

        // --- Helper Functions ---
        function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

        // --- Initialization ---
        function initialize() {
            // Canvas is already created in HTML with correct width/height attributes

            // Add button listeners
            playPauseBtn.addEventListener('click', togglePlayPause);
            resetBtn.addEventListener('click', resetPlayback);

            // Add tooltip listeners to the canvas
            canvas.addEventListener('mousemove', showTooltip);
            canvas.addEventListener('mouseleave', hideTooltip);


            // Display initial frame
            if (totalFrames > 0 && horizontalRays > 0 && verticalRays > 0) {
                displayFrame(currentFrameIndex);
                playPauseBtn.disabled = false;
                resetBtn.disabled = false;
            } else {
                 frameInfo.textContent = 'No data loaded or invalid dimensions.';
                 playPauseBtn.disabled = true;
                 resetBtn.disabled = true;
                 // Optionally draw an error message on canvas
                 if (ctx) {
                    ctx.fillStyle = '#FF0000';
                    ctx.font = '16px sans-serif';
                    ctx.fillText('Error loading data', 10, 20);
                 }
            }
        }

        // --- Display Logic (Using Canvas) ---
        function displayFrame(frameIndex) {
            if (!ctx || frameIndex < 0 || frameIndex >= totalFrames) {
                console.warn("Invalid frame index or canvas context:", frameIndex);
                stopPlayback();
                return;
            }

            const sequenceData = allSequences[frameIndex];
            const displayTickIndex = K > 0 ? K - 1 : 0;

            if (!sequenceData?.vision_dist_seq?.[displayTickIndex] || !sequenceData?.vision_block_id_seq?.[displayTickIndex]) {
                 console.error("Missing vision data for frame:", frameIndex, "tick", displayTickIndex);
                 // Clear canvas to show background color on error
                 ctx.clearRect(0, 0, canvas.width, canvas.height);
                 return;
            }
            const tickDistData = sequenceData.vision_dist_seq[displayTickIndex];
            const tickBlockIdData = sequenceData.vision_block_id_seq[displayTickIndex];

            // Optional: Check dimensions match (already done in backend, but belt-and-suspenders)
            if (tickDistData.length !== verticalRays || tickBlockIdData.length !== verticalRays ||
                (verticalRays > 0 && (tickDistData[0].length !== horizontalRays || tickBlockIdData[0].length !== horizontalRays))) {
                 console.warn(\`Dimension mismatch in frame \${frameIndex}. Skipping display.\`);
                 ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear on mismatch
                 return;
            }

            // --- Drawing Loop ---
            // Clear previous frame (optional, could skip if drawing covers everything)
            // ctx.clearRect(0, 0, canvas.width, canvas.height);

            for (let v = 0; v < verticalRays; v++) {
                for (let h = 0; h < horizontalRays; h++) {
                    const distanceValue = tickDistData[v]?.[h] ?? MAX_RAYCAST_DISTANCE_UNITS;
                    const blockId = tickBlockIdData[v]?.[h] ?? 0;

                    // Get pre-calculated base HSL color
                    const baseHsl = stateIdToHsl[blockId] || stateIdToHsl['unknown'];

                    // Calculate shaded lightness
                    const clampedDistance = clamp(distanceValue, 0, MAX_RAYCAST_DISTANCE_UNITS);
                    const normalizedDistance = clampedDistance / MAX_RAYCAST_DISTANCE_UNITS;
                    const targetLightness = MIN_LIGHTNESS_PERCENT + normalizedDistance * (MAX_LIGHTNESS_PERCENT - MIN_LIGHTNESS_PERCENT);

                    // Set fill style using HSL
                    ctx.fillStyle = \`hsl(\${baseHsl.h}, \${baseHsl.s}%, \${clamp(targetLightness, 0, 100)}%)\`;

                    // Draw the rectangle for this cell
                    ctx.fillRect(h * CELL_SIZE, v * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                }
            }
            // --- End Drawing Loop ---

            frameInfo.textContent = \`Frame: \${frameIndex} / \${totalFrames - 1}\`;
        }

        // --- Tooltip Logic (Adapted for Canvas) ---
         function showTooltip(event) {
            if (totalFrames === 0) return; // No data to show

            // Calculate grid coordinates from mouse position relative to canvas
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;    // Handle CSS scaling
            const scaleY = canvas.height / rect.height;
            const canvasX = (event.clientX - rect.left) * scaleX;
            const canvasY = (event.clientY - rect.top) * scaleY;

            const h = Math.floor(canvasX / CELL_SIZE);
            const v = Math.floor(canvasY / CELL_SIZE);

            // Check if mouse is within grid bounds
            if (h >= 0 && h < horizontalRays && v >= 0 && v < verticalRays) {
                // Get data for the *current* frame being displayed
                const sequenceData = allSequences[currentFrameIndex];
                const displayTickIndex = K > 0 ? K - 1 : 0;

                if (!sequenceData?.vision_dist_seq?.[displayTickIndex] || !sequenceData?.vision_block_id_seq?.[displayTickIndex]) {
                    tooltip.style.display = 'none'; // Hide if data missing
                    return;
                }
                const tickDistData = sequenceData.vision_dist_seq[displayTickIndex];
                const tickBlockIdData = sequenceData.vision_block_id_seq[displayTickIndex];

                const distanceValue = tickDistData[v]?.[h] ?? MAX_RAYCAST_DISTANCE_UNITS;
                const blockId = tickBlockIdData[v]?.[h] ?? 0;
                const distance = (distanceValue / 10).toFixed(1);
                const blockName = stateIdToName[blockId] || 'Unknown';

                tooltip.textContent = \`[H:\${h}, V:\${v}] Dist: \${distance}b, Type: \${blockName} (ID:\${blockId})\`;
                tooltip.style.display = 'block';

                // Position tooltip (same logic as before)
                const xOffset = 15; const yOffset = 10;
                let x = event.clientX + xOffset; let y = event.clientY + yOffset;
                const tooltipRect = tooltip.getBoundingClientRect();
                if (x + tooltipRect.width > window.innerWidth) x = event.clientX - tooltipRect.width - xOffset;
                if (y + tooltipRect.height > window.innerHeight) y = event.clientY - tooltipRect.height - yOffset;
                tooltip.style.left = \`\${x}px\`;
                tooltip.style.top = \`\${y}px\`;

            } else {
                // Mouse is outside the grid area on the canvas
                hideTooltip();
            }
        }

        function hideTooltip() {
            tooltip.style.display = 'none';
        }


        // --- Playback Controls (Unchanged logic, just calls new displayFrame) ---
        function togglePlayPause() { if (isPlaying) pausePlayback(); else startPlayback(); }

        function startPlayback() {
            if (isPlaying || totalFrames === 0 || horizontalRays === 0 || verticalRays === 0) return;
            if (currentFrameIndex >= totalFrames - 1) resetPlayback();
            isPlaying = true;
            playPauseBtn.textContent = 'Pause';
            intervalId = setInterval(() => {
                currentFrameIndex++;
                if (currentFrameIndex >= totalFrames) {
                    currentFrameIndex = totalFrames - 1;
                    pausePlayback();
                } else {
                    displayFrame(currentFrameIndex); // Calls canvas displayFrame
                }
            }, playbackSpeedMs);
        }

        function pausePlayback() {
            if (!isPlaying) return;
            isPlaying = false;
            playPauseBtn.textContent = 'Play';
            clearInterval(intervalId);
            intervalId = null;
        }

        function resetPlayback() {
            pausePlayback();
            currentFrameIndex = 0;
            if (totalFrames > 0 && horizontalRays > 0 && verticalRays > 0) {
                displayFrame(currentFrameIndex); // Calls canvas displayFrame
            }
             frameInfo.textContent = \`Frame: 0 / \${totalFrames > 0 ? totalFrames - 1 : 0}\`;
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

// --- Start Server (Unchanged) ---
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\nVisualization server running.`);
  console.log(`Data file: ${processedDataPath}`);
  if (inferredVisionWidth > 0 && inferredVisionHeight > 0) {
    console.log(`Detected Dimensions: ${inferredVisionWidth} x ${inferredVisionHeight}`);
    console.log(`Open http://localhost:${PORT} in your browser.\n`);
  } else if (totalFrames > 0) {
    console.error(`\nError: Could not determine dimensions from data. Visualization might not work.`);
    console.error(`Please check the data file: ${processedDataPath}\n`);
  } else {
    console.warn(`\nWarning: No data loaded. Server started but visualization will be empty.`);
    console.warn(`Open http://localhost:${PORT} in your browser.\n`);
  }
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`Error: Port ${PORT} is already in use.`);
  else console.error("Server error:", err);
  process.exit(1);
});