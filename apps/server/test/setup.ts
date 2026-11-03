// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';

// Never touch the real ~/.crewtree or ~/.claude from tests
process.env.CREWTREE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-test-'));
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-claude-'));
process.env.CREWTREE_DRIVER = 'fake';
process.env.CREWTREE_NO_UPDATE_CHECK = '1';
