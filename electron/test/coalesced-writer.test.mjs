import test from 'node:test';
import assert from 'node:assert/strict';
import {coalescedWriter} from '../coalesced-writer.mjs';
test('rapid transitions eventually write latest state without another game event',()=>{
 let time=0;let scheduled;const values=[];const canceled=[];
 const writer=coalescedWriter(v=>values.push(v),{now:()=>time,schedule:cb=>{scheduled=cb;return 1;},cancel:id=>canceled.push(id)});
 writer.update('menu');time=20;writer.update('playing');time=100;writer.update('replay');
 assert.deepEqual(values,['menu']);time=1000;scheduled();assert.deepEqual(values,['menu','replay']);
 time=1001;writer.update('results');writer.stop();assert.deepEqual(canceled,[1]);
});
