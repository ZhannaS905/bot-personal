'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {bookingChanges} = require('../src/fitpp-calendar-booking-reconcile');

test('yes creates booking', () => {
  const result = bookingChanges(
    {votes: {'80': 'Тест'}, last: {'80': 200}},
    {},
    () => 'client-1'
  );
  assert.deepEqual(result.changes, [
    {uid: '80', clientId: 'client-1', booked: true}
  ]);
  assert.deepEqual(result.nextClients, {'80': 'client-1'});
});

test('cancel removes existing booking', () => {
  const result = bookingChanges(
    {votes: {}, last: {'80': 300}},
    {'80': 'client-1'},
    () => 'client-1'
  );
  assert.deepEqual(result.changes, [
    {uid: '80', clientId: 'client-1', booked: false}
  ]);
  assert.deepEqual(result.nextClients, {});
});

test('changed binding cancels old booking and creates new one', () => {
  const result = bookingChanges(
    {votes: {'80': 'Тест'}, last: {'80': 400}},
    {'80': 'client-1'},
    () => 'client-2'
  );
  assert.deepEqual(result.changes, [
    {uid: '80', clientId: 'client-1', booked: false},
    {uid: '80', clientId: 'client-2', booked: true}
  ]);
  assert.deepEqual(result.nextClients, {'80': 'client-2'});
});

test('unchanged booking requires no write', () => {
  const result = bookingChanges(
    {votes: {'80': 'Тест'}, last: {'80': 200}},
    {'80': 'client-1'},
    () => 'client-1'
  );
  assert.deepEqual(result.changes, []);
});

test('missing binding creates no booking', () => {
  const result = bookingChanges(
    {votes: {'81': 'Новый'}, last: {'81': 300}},
    {},
    () => null
  );
  assert.deepEqual(result.changes, []);
});
