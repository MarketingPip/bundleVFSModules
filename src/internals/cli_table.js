import Table from "easy-table";

/* ---------------- getTable ---------------- */

const isString = (x) => typeof x === "string";

const isArrayOf = (fn, arr) =>
  Array.isArray(arr) && arr.every(fn);

const isArrayOfStrings = (arr) => isArrayOf(isString, arr);
const isArrayOfArrays = (arr) => isArrayOf(Array.isArray, arr);

function arrayToString(arr) {
  const t = new Table();

  arr.forEach((record) => {
    if (typeof record === "string" || typeof record === "number") {
      t.cell("item", record);
    } else {
      Object.keys(record).forEach((key) => {
        t.cell(key, record[key]);
      });
    }
    t.newRow();
  });

  return t.toString();
}

function objectToArray(obj) {
  return Object.keys(obj).map((key) => ({
    key,
    value: obj[key]
  }));
}

function objectToString(obj) {
  return arrayToString(objectToArray(obj));
}

function printTableWithColumnTitles(titles, items) {
  const t = new Table();

  items.forEach((row) => {
    row.forEach((value, i) => {
      t.cell(titles[i], value);
    });
    t.newRow();
  });

  return t.toString();
}

function getTitleTable(title, arr) {
  const str = arrayToString(arr);
  let rowLength = str.indexOf("\n");

  let out = "";

  if (rowLength > 0) {
    if (title.length > rowLength) rowLength = title.length;

    out += title + "\n";
    out += "-".repeat(rowLength) + "\n";
  }

  return out + str;
}

function getTable(...args) {
  if (
    args.length === 2 &&
    typeof args[0] === "string" &&
    Array.isArray(args[1])
  ) {
    return getTitleTable(args[0], args[1]);
  }

  if (
    args.length === 2 &&
    isArrayOfStrings(args[0]) &&
    isArrayOfArrays(args[1])
  ) {
    return printTableWithColumnTitles(args[0], args[1]);
  }

  let out = "";

  args.forEach((k, i) => {
    if (typeof k === "string") {
      out += k;
      if (i !== args.length - 1) out += "\n";
    } else if (Array.isArray(k)) {
      out += arrayToString(k) + "\n";
    } else if (typeof k === "object") {
      out += objectToString(k);
    }
  });

  return out;
}

/* ---------------- stealth console.table ---------------- */

const originalConsoleTable = globalThis.console.table;

const originalDescriptor =
  Object.getOwnPropertyDescriptor(console, "table");

/* patched function */

function table(...args) {
  const str = getTable(...args);
  return originalConsoleTable.call(console, str);
}

/* preserve metadata */

Object.defineProperty(table, "name", {
  value: "table"
});

Object.defineProperty(table, "length", {
  value: 0
});

/* native toString spoof */

const nativeString = "function table() { [native code] }";

table.toString = () => nativeString;

const originalFnToString = Function.prototype.toString;

Function.prototype.toString = function () {
  if (this === table || this === console.table) {
    return nativeString;
  }
  return originalFnToString.call(this);
};

/* install patch while preserving descriptor */

globalThis.console.table = table;
        
Object.defineProperty(console, "table", {
  ...originalDescriptor,
  value: table
});
