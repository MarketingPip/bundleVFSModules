const Navigator = function Navigator() {};

Navigator.prototype.constructor = Navigator;

const navigator = Object.create(Navigator.prototype);

Object.defineProperty(Navigator.prototype, Symbol.toStringTag, {
  value: 'Navigator',
  enumerable: false,
  configurable: true
});

console.log(navigator);
console.log(Object.prototype.toString.call(navigator));
// [object Navigator]
