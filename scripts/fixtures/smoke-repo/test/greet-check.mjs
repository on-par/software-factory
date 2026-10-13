import assert from 'node:assert/strict';

import { greet } from '../src/greet.mjs';

assert.equal(greet('smoke'), 'Hello, smoke!');
console.log('ok');
