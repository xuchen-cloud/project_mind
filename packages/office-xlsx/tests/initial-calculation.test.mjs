import {test} from 'node:test'
import assert from 'node:assert/strict'
import {InitialCalculationGate} from '../initial-calculation.ts'

const session=(id,changes={})=>({id,started:true,stopped:false,completed:true,resultApplied:true,...changes})

test('complex automatic formula workbook waits for its post-preload natural resultApplied',()=>{
 const gate=new InitialCalculationGate(),book={formulaMode:true}
 assert.equal(gate.ready(book,false,session(3)),false,'no completion request yet')
 gate.expect(book)
 assert.equal(gate.ready(book,false,session(4)),false,"a partial cycle while the full batch is queued cannot satisfy ready")
 gate.begin(book,3)
 assert.equal(gate.ready(book,false,session(3)),false,'an earlier full/partial cycle cannot satisfy preload')
 assert.equal(gate.ready(book,false,session(4,{completed:false,resultApplied:false})),false)
 assert.equal(gate.ready(book,false,session(4,{resultApplied:false})),false,'calculationEnd alone is insufficient')
 assert.equal(gate.ready(book,false,session(4,{stopped:true})),false,'a cancelled calculation is not complete')
 assert.equal(gate.ready(book,false,session(4)),true)
 assert.equal(gate.ready(book,false,session(5,{completed:false,resultApplied:false})),false,'a newer running cycle must settle')
})

test('no-formula, manual and non-formula streaming workbooks do not wait or start a calculation',()=>{
 const gate=new InitialCalculationGate(),notStarted=session(0,{started:false,completed:false})
 assert.equal(gate.ready({formulaMode:false},false,notStarted),true)
 assert.equal(gate.ready({formulaMode:true},true,notStarted),true)
})

test('workbook reset and repeated preload request cannot reuse old resultApplied',()=>{
 const gate=new InitialCalculationGate(),old={formulaMode:true},next={formulaMode:true}
 gate.expect(old);gate.begin(old,2);assert.equal(gate.ready(old,false,session(3)),true)
 assert.equal(gate.ready(next,false,session(3)),false)
 gate.expect(next);gate.begin(next,3);assert.equal(gate.ready(next,false,session(3)),false)
 assert.equal(gate.ready(next,false,session(4)),true)
 gate.expect(next);gate.begin(next,4);assert.equal(gate.ready(next,false,session(4)),false)
})

test('close invalidates queued completion and prevents new requests from reviving the gate',()=>{
 const gate=new InitialCalculationGate(),book={formulaMode:true}
 gate.expect(book);gate.begin(book,2);gate.dispose();gate.expect(book);gate.begin(book,3)
 assert.equal(gate.ready(book,false,session(4)),false)
 assert.equal(gate.ready({formulaMode:false},false,session(4)),false)
})
