const MINECRAFT_VERSION = "1.21.4"; // Ensure this matches the data source if block IDs change significantly

const fs = require("fs");
const path = require("path");
const data = require("minecraft-data")(MINECRAFT_VERSION);

// --- Configuration ---
const K = 4; // Number of ticks to stack for state sequence
const MAX_VELOCITY = 1.0; // Max expected velocity component (blocks/tick) for normalization. Adjust based on observed data.
const MAX_REL_HEIGHT = 10.0; // Max expected relative height difference (+/-) for normalization. Adjust.
// --- REMOVED: VISION_WIDTH and VISION_HEIGHT are now inferred from data ---
// const VISION_WIDTH = 32;
// const VISION_HEIGHT = 48;
// --- END REMOVED ---
const MAX_RAYCAST_DISTANCE_UNITS = 255; // 0-255 representing 0-25.5 blocks
const MAX_RAYCAST_DISTANCE_BLOCKS = 25.5; // Corresponds to MAX_RAYCAST_DISTANCE_UNITS / 10

const States = {
  DEFAULT: 0,
  LADDER: 1,
  VINE: 2,
  WATER: 3,
  LAVA: 4,
  SLIME: 5,
  COBWEB: 6,
  SOUL_SAND: 7,
  ICE: 8,
  BLUE_ICE: 9,
  HONEY: 10,
};

// Define block type mappings
const BlockTypeMap = {
  ladder: States.LADDER,
  vine: States.VINE,
  twisting_vines: States.VINE,
  twisting_vines_plant: States.VINE,
  weeping_vines: States.VINE,
  weeping_vines_plant: States.VINE,
  water: States.WATER,
  lava: States.LAVA,
  slime_block: States.SLIME,
  cobweb: States.COBWEB,
  soul_sand: States.SOUL_SAND,
  ice: States.ICE,
  packed_ice: States.ICE,
  blue_ice: States.BLUE_ICE,
  honey_block: States.HONEY,
};

// --- Helper Functions ---

/** Clamps a value between min and max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/** Normalizes an angle to the range [-180, 180] */
function normalizeAngle(angle) {
  let normalized = angle % 360;
  if (normalized > 180) {
    normalized -= 360;
  } else if (normalized <= -180) {
    normalized += 360;
  }
  return normalized;
}

// --- Main Processing Logic ---

function getBlockType(state) {
  // Get the block name from state
  const blockName = data.blocksByStateId[state]?.name;

  // Return the mapped state or default
  return BlockTypeMap[blockName] || States.DEFAULT;
}

function processFile(inputFilePath, outputFilePath) {
  console.log(`Processing file: ${inputFilePath}`);

  let rawData;
  try {
    const fileContent = fs.readFileSync(inputFilePath, "utf8");
    rawData = JSON.parse(fileContent);
  } catch (err) {
    console.error(`Error reading or parsing input file ${inputFilePath}:`, err);
    return;
  }

  const { ty: targetYaw, tfy: targetFallY, d: ticks } = rawData;

  if (!ticks || ticks.length < K) {
    console.warn(`Skipping file ${inputFilePath}: Not enough ticks (${ticks?.length || 0}) for sequence length ${K}.`);
    return;
  }

  // --- MODIFIED: Infer vision dimensions from the first tick's data ---
  const firstTick = ticks[0];
  if (!firstTick || !firstTick.vd || !Array.isArray(firstTick.vd) || firstTick.vd.length === 0 || !Array.isArray(firstTick.vd[0])) {
    console.error(`Skipping file ${inputFilePath}: Invalid or missing vision data structure in the first tick.`);
    return;
  }
  const inferredVisionHeight = firstTick.vd.length;
  const inferredVisionWidth = firstTick.vd[0].length;
  console.log(`Inferred vision dimensions: ${inferredVisionWidth}x${inferredVisionHeight}`);
  // --- END MODIFIED ---

  const processedSequences = [];

  // Iterate through ticks to create sequences
  // Start from K-1 so we have enough history for the first sequence
  for (let t = K - 1; t < ticks.length; t++) {
    const sequence = {
      // --- MODIFIED: Comments reflect inferred dimensions ---
      vision_dist_seq: [], // Sequence of inferredHeight x inferredWidth byte arrays (0-255)
      vision_block_id_seq: [], // Sequence of inferredHeight x inferredWidth int arrays (block type IDs)
      // --- END MODIFIED ---
      proprio_seq: [], // Sequence of 8-element float arrays (normalized) - pitch removed
      action_t: null, // 7-element float array (0.0/1.0) for tick t
    };

    // Build the sequence from t-k+1 to t
    for (let offset = 0; offset < K; offset++) {
      const tickIndex = t - K + 1 + offset;
      const tickData = ticks[tickIndex];

      // --- MODIFIED: Use inferred dimensions in loops ---
      // 1. Process Vision Distance Grid
      const visionDistGridBytes = [];
      // Check if vision data exists and has expected structure for this specific tick (optional but safer)
      if (!tickData.vd || tickData.vd.length !== inferredVisionHeight || !tickData.vd[0] || tickData.vd[0].length !== inferredVisionWidth) {
        console.warn(`Warning: Vision distance grid dimensions mismatch or missing at tick index ${tickIndex} in file ${inputFilePath}. Expected ${inferredVisionWidth}x${inferredVisionHeight}. Skipping sequence.`);
        // Skip this entire sequence if dimensions mismatch mid-file
        sequence.proprio_seq = null; // Mark sequence as invalid
        break; // Break inner loop
      }
      for (let r = 0; r < inferredVisionHeight; r++) {
        const row = [];
        for (let c = 0; c < inferredVisionWidth; c++) {
          const distBlocks = clamp(tickData.vd[r][c], 0, MAX_RAYCAST_DISTANCE_BLOCKS);
          const distUnits = Math.round(distBlocks * 10); // Scale to 0-255 range (1 decimal place)
          row.push(clamp(distUnits, 0, MAX_RAYCAST_DISTANCE_UNITS)); // Ensure it's within byte range
        }
        visionDistGridBytes.push(row);
      }
      sequence.vision_dist_seq.push(visionDistGridBytes);

      // 2. Process Vision Block Grid
      const visionBlockIdGridBytes = [];
      // Check if vision data exists and has expected structure for this specific tick (optional but safer)
      if (!tickData.vb || tickData.vb.length !== inferredVisionHeight || !tickData.vb[0] || tickData.vb[0].length !== inferredVisionWidth) {
        console.warn(`Warning: Vision block grid dimensions mismatch or missing at tick index ${tickIndex} in file ${inputFilePath}. Expected ${inferredVisionWidth}x${inferredVisionHeight}. Skipping sequence.`);
        sequence.proprio_seq = null; // Mark sequence as invalid
        break; // Break inner loop
      }
      for (let r = 0; r < inferredVisionHeight; r++) {
        const row = [];
        for (let c = 0; c < inferredVisionWidth; c++) {
          const type = getBlockType(tickData.vb[r][c]); // Use getBlockType for mapping
          row.push(type);
        }
        visionBlockIdGridBytes.push(row);
      }
      sequence.vision_block_id_seq.push(visionBlockIdGridBytes);
      // --- END MODIFIED ---

      // 3. Process Proprioceptive Data
      const proprioVector = [];
      // Velocity (normalized)
      proprioVector.push(clamp(tickData.vx / MAX_VELOCITY, -1.0, 1.0));
      proprioVector.push(clamp(tickData.vy / MAX_VELOCITY, -1.0, 1.0));
      proprioVector.push(clamp(tickData.vz / MAX_VELOCITY, -1.0, 1.0));
      // Orientation (normalized relative yaw, pitch removed)
      const deltaYaw = normalizeAngle(tickData.y - targetYaw);
      proprioVector.push(deltaYaw / 180.0); // Scale [-180, 180] to [-1, 1]
      // Pitch removed
      // State Booleans (as floats)
      proprioVector.push(tickData.g ? 1.0 : 0.0);
      proprioVector.push(tickData.ch ? 1.0 : 0.0);
      proprioVector.push(tickData.cv ? 1.0 : 0.0);
      // Relative Height (normalized)
      const deltaY = tickData.py - targetFallY;
      proprioVector.push(clamp(deltaY / MAX_REL_HEIGHT, -1.0, 1.0));

      sequence.proprio_seq.push(proprioVector);
    } // End loop for ticks within a sequence

    // If the inner loop was broken due to dimension mismatch, skip adding this sequence
    if (sequence.proprio_seq === null) {
      continue; // Skip to the next sequence iteration
    }

    // 4. Get Actions for the *last* tick of the sequence (tick t)
    const lastTickData = ticks[t];
    sequence.action_t = [
      lastTickData.f ? 1.0 : 0.0,
      lastTickData.l ? 1.0 : 0.0,
      lastTickData.r ? 1.0 : 0.0,
      lastTickData.b ? 1.0 : 0.0,
      lastTickData.j ? 1.0 : 0.0,
      lastTickData.n ? 1.0 : 0.0, // Sneak
      lastTickData.s ? 1.0 : 0.0, // Sprint
    ];

    processedSequences.push(sequence);
  } // End loop for sequences

  // --- Save Processed Data ---
  if (processedSequences.length === 0) {
    console.warn(`No valid sequences generated for file ${inputFilePath}. Output file will not be created.`);
    return;
  }

  try {
    // Use null, 2 for pretty printing, remove for smaller file size
    const outputJson = JSON.stringify(processedSequences, null, 2);
    fs.writeFileSync(outputFilePath, outputJson, "utf8");
    console.log(`Successfully processed and saved data to: ${outputFilePath}`);
    console.log(`Generated ${processedSequences.length} sequences.`);
  } catch (err) {
    console.error(`Error writing output file ${outputFilePath}:`, err);
  }
}

// --- Script Execution ---

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("Usage: node process_parkour_data.js <input_json_file> <output_json_file>");
  process.exit(1);
}

const inputFilePath = path.resolve(args[0]);
const outputFilePath = path.resolve(args[1]);

if (!fs.existsSync(inputFilePath)) {
  console.error(`Input file not found: ${inputFilePath}`);
  process.exit(1);
}

processFile(inputFilePath, outputFilePath);
