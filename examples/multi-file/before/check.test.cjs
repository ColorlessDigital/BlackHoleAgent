const { test } = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./src/math.cjs');
const { total } = require('./src/cart.cjs');
const { label } = require('./src/label.cjs');

test('add', () => assert.equal(add(2, 3), 5));
test('total', () => assert.equal(total([{ price: 10, quantity: 3 }, { price: 5, quantity: 2 }]), 40));
test('label', () => assert.equal(label('alpha'), 'ALPHA'));
