const MINECRAFT_VERSION = "1.21.4"; // Ensure this matches the data source if block IDs change significantly

const fs = require("fs");
const path = require("path");
const data = require("minecraft-data")(MINECRAFT_VERSION);

// --- Configuration ---
const K = 4; // Number of ticks to stack for state sequence
const MAX_VELOCITY = 1.0;
const MAX_REL_HEIGHT = 10.0;
const MAX_RAYCAST_DISTANCE_UNITS = 255;
const MAX_RAYCAST_DISTANCE_BLOCKS = 25.5;

// --- Binary Format Constants ---
const MAGIC_STRING = "PKDSEQ";
const FORMAT_VERSION = 1;
const HEADER_SIZE = 20; // Calculated size of the header

const States = {
  DEFAULT: 0, LADDER: 1, VINE: 2, WATER: 3, LAVA: 4, SLIME: 5,
  COBWEB: 6, SOUL_SAND: 7, ICE: 8, BLUE_ICE: 9, HONEY: 10,
};

const BlockTypeMap = {
  ladder: States.LADDER, vine: States.VINE, twisting_vines: States.VINE,
  twisting_vines_plant: States.VINE, weeping_vines: States.VINE,
  weeping_vines_plant: States.VINE, water: States.WATER, lava: States.LAVA,
  slime_block: States.SLIME, cobweb: States.COBWEB, soul_sand: States.SOUL_SAND,
  ice: States.ICE, packed_ice: States.ICE, blue_ice: States.BLUE_ICE,
  honey_block: States.HONEY,
};

// --- Helper Functions (Unchanged) ---
function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }
function normalizeAngle(angle) { /* ... (keep existing implementation) ... */
    let normalized = angle % 360;
    if (normalized > 180) normalized -= 360;
    else if (normalized <= -180) normalized += 360;
    return normalized;
}
function getBlockType(state) { /* ... (keep existing implementation) ... */
    const blockName = data.blocksByStateId[state]?.name;
    return BlockTypeMap[blockName] || States.DEFAULT;
}

// --- Main Processing Logic ---
function processFile(inputFilePath, outputFilePath) {
  console.log(`Processing file: ${inputFilePath}`);

  let rawData;
  try {
    const fileContent = fs.readFileSync(inputFilePath, "utf8");
    rawData = JSON.parse(fileContent);
  } catch (err) {
    console.error(`Error reading/parsing JSON ${inputFilePath}:`, err);
    return;
  }

  const { ty: targetYaw, tfy: targetFallY, d: ticks } = rawData;

  if (!ticks || ticks.length < K) {
    console.warn(`Skipping ${inputFilePath}: Not enough ticks (${ticks?.length || 0}) for K=${K}.`);
    return;
  }

  // Infer dimensions
  const firstTick = ticks[0];
  if (!firstTick?.vd?.[0]) {
    console.error(`Skipping ${inputFilePath}: Invalid vision data structure.`);
    return;
  }
  const visionHeight = firstTick.vd.length;
  const visionWidth = firstTick.vd[0].length;
  console.log(`Inferred vision dimensions: ${visionWidth}x${visionHeight}`);

  const visionTickSize = visionWidth * visionHeight; // Bytes per vision grid per tick

  const processedSequences = []; // Still process into JS objects first

  for (let t = K - 1; t < ticks.length; t++) {
    const sequence = {
      vision_dist_seq_flat: [], // Flat Uint8Array K * W * H
      vision_block_id_seq_flat: [], // Flat Uint8Array K * W * H
      proprio_seq: [], // Array of K arrays of 8 floats
      action_byte: 0, // Single byte for actions
    };

    let sequenceValid = true;
    const tempDistBuffers = [];
    const tempBlockIdBuffers = [];

    for (let offset = 0; offset < K; offset++) {
      const tickIndex = t - K + 1 + offset;
      const tickData = ticks[tickIndex];

      // Validate dimensions for this tick
      if (!tickData.vd || tickData.vd.length !== visionHeight || !tickData.vd[0] || tickData.vd[0].length !== visionWidth ||
          !tickData.vb || tickData.vb.length !== visionHeight || !tickData.vb[0] || tickData.vb[0].length !== visionWidth) {
        console.warn(`Warning: Dimension mismatch at tick ${tickIndex} in ${inputFilePath}. Skipping sequence.`);
        sequenceValid = false;
        break;
      }

      // 1. Process Vision Distance Grid -> Flat Buffer for this tick
      const tickDistBuffer = Buffer.allocUnsafe(visionTickSize); // Use Buffer directly
      let bufferIdx = 0;
      for (let r = 0; r < visionHeight; r++) {
        for (let c = 0; c < visionWidth; c++) {
          const distBlocks = clamp(tickData.vd[r][c], 0, MAX_RAYCAST_DISTANCE_BLOCKS);
          const distUnits = Math.round(distBlocks * 10);
          tickDistBuffer.writeUInt8(clamp(distUnits, 0, MAX_RAYCAST_DISTANCE_UNITS), bufferIdx++);
        }
      }
      tempDistBuffers.push(tickDistBuffer);

      // 2. Process Vision Block Grid -> Flat Buffer for this tick
      const tickBlockIdBuffer = Buffer.allocUnsafe(visionTickSize);
      bufferIdx = 0;
      for (let r = 0; r < visionHeight; r++) {
        for (let c = 0; c < visionWidth; c++) {
          const type = getBlockType(tickData.vb[r][c]);
          tickBlockIdBuffer.writeUInt8(type, bufferIdx++);
        }
      }
      tempBlockIdBuffers.push(tickBlockIdBuffer);

      // 3. Process Proprioceptive Data
      const proprioVector = [
        clamp(tickData.vx / MAX_VELOCITY, -1.0, 1.0),
        clamp(tickData.vy / MAX_VELOCITY, -1.0, 1.0),
        clamp(tickData.vz / MAX_VELOCITY, -1.0, 1.0),
        normalizeAngle(tickData.y - targetYaw) / 180.0,
        tickData.g ? 1.0 : 0.0,
        tickData.ch ? 1.0 : 0.0,
        tickData.cv ? 1.0 : 0.0,
        clamp((tickData.py - targetFallY) / MAX_REL_HEIGHT, -1.0, 1.0),
      ];
      sequence.proprio_seq.push(proprioVector);

    } // End loop for ticks within a sequence

    if (!sequenceValid) continue; // Skip if dimension mismatch occurred

    // Concatenate vision buffers
    sequence.vision_dist_seq_flat = Buffer.concat(tempDistBuffers);
    sequence.vision_block_id_seq_flat = Buffer.concat(tempBlockIdBuffers);

    // 4. Get Actions for the *last* tick (t) and create action byte
    const lastTickData = ticks[t];
    let actionByte = 0;
    if (lastTickData.f) actionByte |= (1 << 0);
    if (lastTickData.l) actionByte |= (1 << 1);
    if (lastTickData.r) actionByte |= (1 << 2);
    if (lastTickData.b) actionByte |= (1 << 3);
    if (lastTickData.j) actionByte |= (1 << 4);
    if (lastTickData.n) actionByte |= (1 << 5);
    if (lastTickData.s) actionByte |= (1 << 6);
    sequence.action_byte = actionByte;

    processedSequences.push(sequence);
  } // End loop for sequences

  if (processedSequences.length === 0) {
    console.warn(`No valid sequences generated for ${inputFilePath}. Output file not created.`);
    return;
  }

  // --- Write Binary Data ---
  let fd;
  try {
    fd = fs.openSync(outputFilePath, 'w'); // Open file for writing

    // 1. Write Header
    const headerBuffer = Buffer.alloc(HEADER_SIZE);
    let offset = 0;
    offset += headerBuffer.write(MAGIC_STRING, offset, 'ascii');
    offset = headerBuffer.writeUInt8(FORMAT_VERSION, offset);
    offset = headerBuffer.writeUInt16BE(visionWidth, offset);
    offset = headerBuffer.writeUInt16BE(visionHeight, offset);
    offset = headerBuffer.writeUInt8(K, offset);
    offset = headerBuffer.writeUInt32BE(processedSequences.length, offset);
    offset = headerBuffer.writeUInt32BE(0, offset); // Reserved
    fs.writeSync(fd, headerBuffer, 0, HEADER_SIZE, null);

    // 2. Write Sequence Data
    for (const seq of processedSequences) {
      // Vision Distance
      fs.writeSync(fd, seq.vision_dist_seq_flat, 0, seq.vision_dist_seq_flat.length, null);
      // Vision Block IDs
      fs.writeSync(fd, seq.vision_block_id_seq_flat, 0, seq.vision_block_id_seq_flat.length, null);
      // Proprioceptive Data
      const proprioBufferSize = K * 8 * 4; // K ticks * 8 floats * 4 bytes/float
      const proprioBuffer = Buffer.allocUnsafe(proprioBufferSize);
      let pOffset = 0;
      for (let k_tick = 0; k_tick < K; k_tick++) {
        for (let i = 0; i < 8; i++) {
          pOffset = proprioBuffer.writeFloatBE(seq.proprio_seq[k_tick][i], pOffset);
        }
      }
      fs.writeSync(fd, proprioBuffer, 0, proprioBufferSize, null);
      // Action Byte
      const actionBuffer = Buffer.from([seq.action_byte]);
      fs.writeSync(fd, actionBuffer, 0, 1, null);
    }

    console.log(`Successfully processed and saved BINARY data to: ${outputFilePath}`);
    console.log(`Generated ${processedSequences.length} sequences.`);

  } catch (err) {
    console.error(`Error writing binary output file ${outputFilePath}:`, err);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// --- Script Execution (Unchanged) ---
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("Usage: node process_parkour_data.js <input_json_file> <output_binary_file>");
  process.exit(1);
}
const inputFilePath = path.resolve(args[0]);
const outputFilePath = path.resolve(args[1]); // Now expects binary output path
if (!fs.existsSync(inputFilePath)) {
  console.error(`Input file not found: ${inputFilePath}`);
  process.exit(1);
}
processFile(inputFilePath, outputFilePath); // Call the modified function