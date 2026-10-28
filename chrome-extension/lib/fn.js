/**
 * Pi Annotate - minimal function toolkit (classic script, global PiFn).
 *
 * The shared composition helpers for point-free style in the extension
 * scripts. pipe applies a value through steps; flow composes steps into a
 * function; invoke makes a data-last method caller, so a method can be a
 * named step without an inline lambda (and without losing `this`).
 */
(function (root) {
  /** pipe(value, f, g) is g(f(value)). */
  function pipe(value) {
    for (var i = 1; i < arguments.length; i++) value = arguments[i](value);
    return value;
  }

  /** flow(f, g) is the function x => g(f(x)). (Q, Queer bird) */
  function flow() {
    var fns = arguments;
    return function (x) {
      for (var i = 0; i < fns.length; i++) x = fns[i](x);
      return x;
    };
  }

  /** K, Kestrel */
  function constant(a) {
    return function () { return a; };
  }

  /**
   * invoke("remove")(el) calls el.remove(); invoke("removeAttribute", "x")(el)
   * calls el.removeAttribute("x"). It takes exactly one data argument, so it
   * is safe for Array#forEach and friends, which pass extra arguments.
   */
  function invoke(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function (obj) { return obj[name].apply(obj, args); };
  }

  root.PiFn = { pipe: pipe, flow: flow, constant: constant, invoke: invoke };
})(globalThis);
