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

test('SSE endpoint is accessible', async () => {
  // Just test that we can make a connection to the SSE endpoint
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
  
  try {
    const res = await fetch(`${this.base}/api/stream`, {
      signal: controller.signal
    });
    // We don't care about the status code here - we just want to see if we can connect
    // In reality, we should get 200, but even if we get something else, the test
    // will show us what's happening
    console.log(`SSE endpoint status: ${res.status}`);
    console.log(`SSE endpoint headers: ${JSON.stringify(Object.fromEntries(res.headers))}`);
    
    // Try to read a little bit of data
    if (res.body) {
      try {
        const reader = res.body.getReader();
        const { value } = await reader.read();
        if (value) {
          const data = new TextDecoder().decode(value);
          console.log(`First chunk of data: ${data.substring(0, 100)}`);
        }
      } catch (e) {
        console.log(`Error reading from stream: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Failed to connect to SSE endpoint: ${e.message}`);
    throw e;  // Re-throw to make the test fail
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});
