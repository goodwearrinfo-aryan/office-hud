'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);

// Setup before each test
test.beforeEach(async () => {
  const { base } = await startTestServer(server.app);
  // Store base URL for direct fetch calls
  this.base = base;
});

// Teardown after each test
test.afterEach(async () => {
  // Cleanup is handled by the fixture
});

test('SSE endpoint respects client capacity limit (returns 503 when over limit)', async () => {
  const SSE_MAX_CLIENTS = 16;
  
  // Connect maximum allowed clients (16) - all should succeed
  const controllers = [];
  try {
    for (let i = 0; i < SSE_MAX_CLIENTS; i++) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1000);
      
      const res = await fetch(`${this.base}/api/stream`, {
        signal: controller.signal
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      controllers.push({ controller, res });
    }
    
    // Try to connect one more - should get 503
    const extraController = new AbortController();
    setTimeout(() => extraController.abort(), 1000);
    
    const res = await fetch(`${this.base}/api/stream`, {
      signal: extraController.signal
    });
    console.log(`Status: ${res.status}`);
    console.log(`Headers: ${JSON.stringify(Object.fromEntries(res.headers))}`);
    
    // Let's see what the response body contains
    const text = await res.text();
    console.log(`Response body: ${text}`);
    
    assert.equal(res.status, 503);
    // Try to parse as JSON, but it might not be JSON
    if (res.headers.get('content-type')?.includes('application/json')) {
      const json = JSON.parse(text);
      assert.equal(json.error, 'too many stream clients');
    } else {
      // If it's not JSON, just check that it contains the expected error message
      assert.match(text, /too many stream clients/);
    }
    
    // Clean up the extra controller
    extraController.abort();
  } finally {
    // Clean up all controllers
    for (const { controller } of controllers) {
      controller.abort();
    }
  }
});
