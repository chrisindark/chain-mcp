/**
 * Rejects synchronous filesystem and process APIs on runtime request paths.
 *
 * The rule resolves `fs` and `child_process` imports (including aliases,
 * namespace imports, `require`, and dynamic import) and reports synchronous
 * calls. `node:fs/promises` is asynchronous and is not restricted.
 */

const FILE_SYSTEM_MODULES = new Set(["fs", "node:fs"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);

const FILE_SYSTEM_SYNC_APIS = new Set([
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "globSync",
  "lchmodSync",
  "lchownSync",
  "linkSync",
  "lstatSync",
  "lutimesSync",
  "mkdirSync",
  "mkdtempSync",
  "openSync",
  "opendirSync",
  "readFileSync",
  "readdirSync",
  "readlinkSync",
  "readSync",
  "readvSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statfsSync",
  "statSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "writeSync",
  "writevSync",
]);

const CHILD_PROCESS_SYNC_APIS = new Set([
  "execFileSync",
  "execSync",
  "spawnSync",
]);

const SYNC_APIS = new Set([
  ...FILE_SYSTEM_SYNC_APIS,
  ...CHILD_PROCESS_SYNC_APIS,
]);

function isTrackedModule(source) {
  return FILE_SYSTEM_MODULES.has(source) || CHILD_PROCESS_MODULES.has(source);
}

function isRequireCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    typeof node.arguments[0].value === "string"
  );
}

function isSyncName(name) {
  return typeof name === "string" && SYNC_APIS.has(name);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow synchronous filesystem and child-process calls on runtime request paths",
    },
    schema: [],
    messages: {
      blockingImport:
        "Synchronous I/O '{{name}}' blocks the event loop; use the asynchronous API.",
      blockingCall:
        "Synchronous I/O '{{name}}' blocks the event loop; use the asynchronous API.",
    },
  },

  create(context) {
    /** Local binding names for a module namespace, e.g. `fs` or `nodeFs`. */
    const namespaces = new Set();
    /** Local names bound to a synchronous API through a named import/require. */
    const namedSyncBindings = new Set();

    function report(node, name, messageId) {
      context.report({ node, messageId, data: { name } });
    }

    function recordNamespaceBinding(id) {
      if (id && id.type === "Identifier") namespaces.add(id.name);
    }

    function inspectNamedSpecifier(node, importedName, localName) {
      if (!isSyncName(importedName)) return;
      namedSyncBindings.add(localName);
      // Report the import itself so aliases and unused imports are caught too.
      report(node, importedName, "blockingImport");
    }

    function inspectObjectPattern(pattern) {
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        if (property.computed) continue;
        const importedName =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal"
              ? property.key.value
              : undefined;
        if (typeof importedName !== "string") continue;
        if (!isSyncName(importedName)) continue;
        const localName =
          property.value.type === "Identifier"
            ? property.value.name
            : importedName;
        namedSyncBindings.add(localName);
        report(property, importedName, "blockingImport");
      }
    }

    function recordRequireBinding(id) {
      if (id.type === "Identifier") {
        namespaces.add(id.name);
        return;
      }
      if (id.type === "ObjectPattern") inspectObjectPattern(id);
    }

    function inspectMember(node) {
      const { object, property, computed } = node;
      const propertyName = computed
        ? property.type === "Literal" && typeof property.value === "string"
          ? property.value
          : undefined
        : property.type === "Identifier"
          ? property.name
          : undefined;
      if (!isSyncName(propertyName)) return;

      if (object.type === "Identifier" && namespaces.has(object.name)) {
        report(node, propertyName, "blockingCall");
        return;
      }
      if (isRequireCall(object)) {
        const source = object.arguments[0].value;
        if (isTrackedModule(source)) {
          report(node, propertyName, "blockingCall");
        }
      }
    }

    function inspectDynamicImport(node) {
      if (node.source.type !== "Literal") return;
      if (!isTrackedModule(node.source.value)) return;
      const declarator =
        node.parent.type === "AwaitExpression"
          ? node.parent.parent
          : node.parent;
      if (declarator?.type !== "VariableDeclarator") return;
      if (declarator.id.type === "Identifier") {
        namespaces.add(declarator.id.name);
      } else if (declarator.id.type === "ObjectPattern") {
        inspectObjectPattern(declarator.id);
      }
    }

    return {
      ImportDeclaration(node) {
        if (!isTrackedModule(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const importedName =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : String(specifier.imported.value);
            inspectNamedSpecifier(
              specifier,
              importedName,
              specifier.local.name,
            );
          } else if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            recordNamespaceBinding(specifier.local);
          }
        }
      },

      VariableDeclarator(node) {
        if (node.init && isRequireCall(node.init)) {
          const source = node.init.arguments[0].value;
          if (isTrackedModule(source)) recordRequireBinding(node.id);
          return;
        }
        // `const { readFileSync } = fs` where `fs` is a tracked namespace.
        if (
          node.init?.type === "Identifier" &&
          namespaces.has(node.init.name) &&
          node.id.type === "ObjectPattern"
        ) {
          inspectObjectPattern(node.id);
        }
      },

      ImportExpression: inspectDynamicImport,

      MemberExpression: inspectMember,

      CallExpression(node) {
        // A directly imported synchronous binding may be called through an
        // alias, e.g. `import { readFileSync as read }`.
        if (
          node.callee.type === "Identifier" &&
          namedSyncBindings.has(node.callee.name)
        ) {
          report(node, node.callee.name, "blockingCall");
        }
      },
    };
  },
};
