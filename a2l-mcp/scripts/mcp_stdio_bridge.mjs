import readline from 'readline';
import { stdin, stdout } from 'process';

// Use node-fetch for HTTP requests
import fetch from 'node-fetch';

const MCP_URL = 'http://localhost:3000/mcp';

const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: false
});

rl.on('line', async (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        stdout.write(JSON.stringify({ error: 'Invalid JSON', details: err.message }) + '\n');
        return;
    }

    try {
        const headers = { 'Content-Type': 'application/json' };

        // Add bearer token if STUDY_MCP_TOKEN is set
        if (process.env.STUDY_MCP_TOKEN) {
            headers['Authorization'] = `Bearer ${process.env.STUDY_MCP_TOKEN}`;
        }

        const res = await fetch(MCP_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(msg)
        });
        const data = await res.json();
        stdout.write(JSON.stringify(data) + '\n');
    } catch (err) {
        stdout.write(JSON.stringify({ error: 'HTTP request failed', details: err.message }) + '\n');
    }
});