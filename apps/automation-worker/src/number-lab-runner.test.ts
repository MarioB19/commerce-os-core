import {describe,expect,it} from 'vitest';
import {code,NOT_ADMITTED_AFTER_SECONDS} from './number-lab-runner.js';

// V7.5.2 L01: a laboratory failure is diagnosable from the worker log without
// printing a path, a key or content (V7.5.1 logged only UNEXPECTED for EROFS).
describe('number lab runner diagnostics',()=>{
 it('keeps the stable code and adds the OS code, never the message or path',()=>{
  const raw=Object.assign(Error("EROFS: read-only file system, open '/data/private/.private-namespace.lock'"),{code:'EROFS'});
  expect(code(raw)).toBe('FS_EROFS');expect(code(raw)).not.toContain('/data');
  expect(code(Object.assign(Error('PRIVATE_NAMESPACE_LOCK_UNINITIALIZED'),{code:'EROFS'}))).toBe('PRIVATE_NAMESPACE_LOCK_UNINITIALIZED EROFS');
  expect(code(Error('LAB_DRIVER_CONTROL_NOT_LIVE'))).toBe('LAB_DRIVER_CONTROL_NOT_LIVE');
  expect(code(Error('something with secret sk-ant-xyz'))).toBe('UNEXPECTED');expect(code('x')).toBe('UNEXPECTED');
 });
 it('waits longer than one material preparation before closing a step the engine never admitted',()=>{expect(NOT_ADMITTED_AFTER_SECONDS).toBeGreaterThanOrEqual(600);});
});
