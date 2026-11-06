'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const statuses = new Set(['attempted', 'sent', 'uncertain', 'rejected', 'unlinked', 'stale']);

function openLedger(directory, {scope, start}) {
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(start) || start < 0)
    throw Error('PERSONAL_LEDGER_SETTINGS_REFUSED');
  const folder = fs.statSync(directory);
  if (!folder.isDirectory() || (folder.mode & 0o077) !== 0) throw Error('PERSONAL_LEDGER_DIRECTORY_REFUSED');
  const cursorPath = path.join(directory, 'cursor-v1.json');
  const eventPath = key => path.join(directory, createHash('sha256').update(scope + ':' + key).digest('hex'));

  function persist(file, value, exclusive = false) {
    const temp = path.join(directory, '.' + randomUUID());
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, value);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        if (exclusive) fs.linkSync(temp, file);
        else fs.renameSync(temp, file);
      } catch (error) {
        if (exclusive && error.code === 'EEXIST') return false;
        throw error;
      }
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return true;
    } finally {
      fs.rmSync(temp, {force: true});
    }
  }

  function read(file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  function cursor() {
    const record = JSON.parse(read(cursorPath));
    if (record?.scope !== scope || record.start !== start ||
        !Number.isSafeInteger(record.revision) || record.revision < start) throw Error('PERSONAL_LEDGER_SCOPE_REFUSED');
    return record.revision;
  }

  const record = revision => JSON.stringify({scope, start, revision});
  if (read(cursorPath) === undefined) persist(cursorPath, record(start), true);
  cursor();
  return {
    cursor,
    advance(revision) {
      if (revision > cursor()) persist(cursorPath, record(revision));
    },
    status(key) {
      const value = read(eventPath(key));
      if (value !== undefined && !statuses.has(value)) throw Error('PERSONAL_LEDGER_STATUS_REFUSED');
      return value;
    },
    claim: key => persist(eventPath(key), 'attempted', true),
    finish(key, status) {
      if (!statuses.has(status) || status === 'attempted') throw Error('PERSONAL_LEDGER_STATUS_REFUSED');
      persist(eventPath(key), status);
    }
  };
}

module.exports = {openLedger};
