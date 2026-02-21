#!/usr/bin/env node
/**
 * E2E test: Create project → Upload docs with docType → Start execution
 * Validates that both frontend and backend agents start, read PDFs, and produce output.
 */
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const WS_URL = 'ws://localhost:3456';
const PROJECT_ID = crypto.randomUUID();
const PROJECT_NAME = 'E2E Test - Invoice Spec';

const FRONTEND_PATH = '/Users/huangszhsien/Documents/程式/fork/ofeinvoice_ui';
const BACKEND_PATH = '/Users/huangszhsien/Documents/程式/fork/ofeinvoice';

const DOCS = [
  {
    path: path.join(FRONTEND_PATH, 'SPEC_SB03_電子發票號碼查詢_V0.3.docx.pdf'),
    docType: 'SA',
  },
  {
    path: path.join(FRONTEND_PATH, 'SPEC_SB03_電子發票號碼查詢_v0.8.docx.pdf'),
    docType: 'SD',
  },
];

// ---- Test State ----
const state = {
  agentsStarted: new Set(),  // agent IDs that entered "running"
  agentRoles: {},             // agentId -> role
  agentOutputCount: {},       // agentId -> output count
  agentToolUses: {},          // agentId -> tool_use count
  agentReadPdf: {},           // agentId -> true if read a PDF
  errors: [],
};

const TIMEOUT_MS = 120_000; // 2 minutes max wait
const CHECK_INTERVAL_MS = 5_000;

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
  console.log(`>>> ${msg.type}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printStatus() {
  console.log('\n--- Current Status ---');
  for (const [id, role] of Object.entries(state.agentRoles)) {
    const short = id.slice(0, 8);
    const started = state.agentsStarted.has(id) ? 'RUNNING' : 'waiting';
    const outputs = state.agentOutputCount[id] || 0;
    const tools = state.agentToolUses[id] || 0;
    const pdf = state.agentReadPdf[id] ? 'YES' : 'no';
    console.log(`  [${role}] ${short}... ${started} | ${outputs} outputs | ${tools} tools | PDF read: ${pdf}`);
  }
  if (state.errors.length > 0) {
    console.log(`  ERRORS: ${state.errors.length}`);
    state.errors.forEach(e => console.log(`    - ${e}`));
  }
  console.log('');
}

async function main() {
  console.log('========================================');
  console.log('  AI-OmniCommander E2E Test');
  console.log('========================================');
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log(`Frontend: ${FRONTEND_PATH}`);
  console.log(`Backend: ${BACKEND_PATH}`);
  console.log('');

  // Validate files exist
  for (const doc of DOCS) {
    if (!fs.existsSync(doc.path)) {
      console.error(`FATAL: File not found: ${doc.path}`);
      process.exit(1);
    }
  }

  const ws = new WebSocket(WS_URL);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const type = msg.type;

      if (type === 'error') {
        state.errors.push(msg.payload?.message || JSON.stringify(msg.payload));
        console.log(`<<< ERROR: ${msg.payload?.message}`);
      } else if (type === 'agent.statusChange') {
        const { agentId, newStatus } = msg.payload;
        if (newStatus === 'running') {
          state.agentsStarted.add(agentId);
        }
        console.log(`<<< agent.statusChange: ${(state.agentRoles[agentId] || '?')} -> ${newStatus}`);
      } else if (type === 'agent.output') {
        const p = msg.payload;
        const agentId = p.agentId;
        state.agentOutputCount[agentId] = (state.agentOutputCount[agentId] || 0) + 1;
        if (p.streamType === 'tool_use') {
          state.agentToolUses[agentId] = (state.agentToolUses[agentId] || 0) + 1;
          // Check if reading a PDF
          if (p.toolName === 'Read' && p.content?.includes('.pdf')) {
            state.agentReadPdf[agentId] = true;
          }
        }
        if (p.streamType === 'tool_result' && p.content?.includes('PDF')) {
          state.agentReadPdf[agentId] = true;
        }
        // Only print text and tool_use (not tool_result to reduce noise)
        if (p.streamType === 'text' || p.streamType === 'tool_use') {
          const role = state.agentRoles[agentId] || '?';
          const preview = p.content?.substring(0, 100);
          console.log(`<<< [${role}] ${p.streamType}: ${preview}`);
        }
      } else if (type === 'agent.started') {
        // agent.started is broadcast directly (not wrapped in eventbus.notification)
        const agentId = msg.payload?.agentId;
        const role = msg.payload?.role || 'unknown';
        if (agentId) {
          state.agentRoles[agentId] = role;
          console.log(`<<< agent.started: ${role} (${agentId.slice(0, 8)}...)`);
        }
      } else if (type === 'project.state' || type === 'projects.list') {
        // Quiet
      } else {
        console.log(`<<< ${type}`);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    state.errors.push(`WS: ${err.message}`);
  });

  ws.on('close', (code) => {
    console.log(`WebSocket closed: ${code}`);
  });

  await new Promise((resolve) => ws.on('open', resolve));
  console.log('Connected to server\n');
  await sleep(500);

  // Step 1: Create project
  console.log('=== Step 1: Create Project ===');
  send(ws, {
    type: 'project.create',
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: {
      projectId: PROJECT_ID,
      name: PROJECT_NAME,
      mode: 'spec',
      workingDir: FRONTEND_PATH,
      workspaces: [
        { label: 'frontend', path: FRONTEND_PATH },
        { label: 'backend', path: BACKEND_PATH },
      ],
    },
  });
  await sleep(1000);

  // Step 2: Upload documents
  console.log('\n=== Step 2: Upload Documents ===');
  for (const doc of DOCS) {
    const filename = path.basename(doc.path);
    const content = fs.readFileSync(doc.path).toString('base64');
    console.log(`Uploading: ${filename} (${doc.docType}) [${(content.length / 1024).toFixed(0)}KB base64]`);

    send(ws, {
      type: 'project.uploadDocument',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: PROJECT_ID,
        filename,
        content,
        fileType: 'base64',
        docType: doc.docType,
      },
    });
    await sleep(1000);
  }

  // Step 3: Start execution
  console.log('\n=== Step 3: Start Execution ===');
  send(ws, {
    type: 'project.startExecution',
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: { projectId: PROJECT_ID },
  });

  // Step 4: Wait for agents to start and produce output
  console.log('\n=== Step 4: Waiting for agents... ===\n');
  const startTime = Date.now();
  let success = false;

  while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(CHECK_INTERVAL_MS);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${elapsed}s elapsed]`);
    printStatus();

    // Check success criteria:
    // 1. At least 2 agents started (frontend + backend)
    // 2. Both agents have produced output
    // 3. Both agents have used tools
    // 4. At least one agent has read a PDF
    const roles = new Set(Object.values(state.agentRoles));
    const hasFrontend = roles.has('frontend');
    const hasBackend = roles.has('backend');
    const allStarted = state.agentsStarted.size >= 2;

    const frontendId = Object.entries(state.agentRoles).find(([, r]) => r === 'frontend')?.[0];
    const backendId = Object.entries(state.agentRoles).find(([, r]) => r === 'backend')?.[0];

    const frontendOutput = frontendId ? (state.agentOutputCount[frontendId] || 0) : 0;
    const backendOutput = backendId ? (state.agentOutputCount[backendId] || 0) : 0;
    const frontendTools = frontendId ? (state.agentToolUses[frontendId] || 0) : 0;
    const backendTools = backendId ? (state.agentToolUses[backendId] || 0) : 0;
    const anyPdfRead = Object.values(state.agentReadPdf).some(v => v);

    if (hasFrontend && hasBackend && allStarted &&
        frontendOutput >= 5 && backendOutput >= 5 &&
        frontendTools >= 3 && backendTools >= 3 &&
        anyPdfRead && state.errors.length === 0) {
      success = true;
      break;
    }

    // Early fail if errors
    if (state.errors.length > 0) {
      console.log('ERRORS detected, stopping early.');
      break;
    }
  }

  // Final report
  console.log('\n========================================');
  console.log('  TEST RESULTS');
  console.log('========================================');
  printStatus();

  if (success) {
    console.log('✅ E2E TEST PASSED');
    console.log('  - Both frontend and backend agents started');
    console.log('  - Both agents produced output and used tools');
    console.log('  - PDF files were read successfully');
  } else {
    console.log('❌ E2E TEST FAILED');
    if (state.errors.length > 0) {
      console.log('  Errors:');
      state.errors.forEach(e => console.log(`    - ${e}`));
    }
    if (state.agentsStarted.size < 2) {
      console.log(`  Only ${state.agentsStarted.size} agents started (expected 2)`);
    }
  }

  console.log('\nClosing connection...');
  ws.close();

  // Don't exit immediately — let agents keep running
  await sleep(1000);
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
