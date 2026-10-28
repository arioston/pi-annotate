import test from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const sandbox = {};
sandbox.globalThis = sandbox;
loadClassic("chrome-extension/lib/fn.js", sandbox);
const { pipe, flow, constant, invoke } = sandbox.PiFn;

const inc = (n) => n + 1;
const double = (n) => n * 2;

test("pipe applies a value through the steps in order", () => {
  assert.equal(pipe(3, inc, double), 8);
  assert.equal(pipe(3), 3);
});

test("flow composes steps into one function", () => {
  assert.equal(flow(inc, double)(3), 8);
  assert.equal(flow()(3), 3);
});

test("constant always returns its value and ignores arguments", () => {
  const zero = constant(0);
  assert.equal(zero(), 0);
  assert.equal(zero(9, 9), 0);
});

test("invoke calls the method on its receiver with the fixed arguments", () => {
  const calls = [];
  const el = {
    remove() { calls.push(["remove", this === el]); },
    removeAttribute(name) { calls.push(["removeAttribute", name, this === el]); },
  };
  invoke("remove")(el);
  invoke("removeAttribute", "data-pi-changed")(el);
  assert.deepEqual(calls, [["remove", true], ["removeAttribute", "data-pi-changed", true]]);
});

test("invoke takes one data argument, so forEach extras never leak in", () => {
  const seen = [];
  const make = (id) => ({ id, mark(...args) { seen.push([this.id, ...args]); } });
  [make("a"), make("b")].forEach(invoke("mark", "x"));
  assert.deepEqual(seen, [["a", "x"], ["b", "x"]]);
});
