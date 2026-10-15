import { spawnSync } from "node:child_process";

// Explicitly time-box the single upstream-unpatched build-tool advisory; only its dependent chain is exempted.
const BRACES_ADVISORY = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const BRACES_REVIEW_BY = "2026-11-15";
const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
});

let report;
try {
  report = JSON.parse(audit.stdout || "");
} catch {
  process.stderr.write(audit.stderr || audit.stdout || "npm audit did not return valid JSON\n");
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const isKnownBracesException = (vulnerability) => {
  if (vulnerability.name !== "braces" || new Date().toISOString().slice(0, 10) > BRACES_REVIEW_BY) {
    return false;
  }
  const highVia = (vulnerability.via ?? []).filter((item) =>
    typeof item === "object" && item.severity === "high"
  );
  return highVia.length > 0 && highVia.every((item) => item.url === BRACES_ADVISORY);
};

const advisoryRoots = (name, path = new Set()) => {
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability) return { roots: new Set(), unknown: true };
  if (path.has(name)) return { roots: new Set(), unknown: false };

  const nextPath = new Set(path);
  nextPath.add(name);
  const roots = new Set();
  let unknown = false;
  const via = vulnerability.via ?? [];

  if (via.length === 0) unknown = true;
  for (const item of via) {
    if (typeof item === "string") {
      const child = advisoryRoots(item, nextPath);
      for (const root of child.roots) roots.add(root);
      unknown ||= child.unknown;
    } else if (item && typeof item.url === "string") {
      roots.add(item.url);
    } else {
      unknown = true;
    }
  }
  return { roots, unknown };
};

const isBracesOnlyChain = (name) => {
  if (!isKnownBracesException(report.vulnerabilities?.braces)) return false;
  const result = advisoryRoots(name);
  // Do not suppress a package if any direct/transitive cause is unknown, or if
  // another advisory is reachable. The exception only covers chains whose sole
  // root advisory is the unpatched braces finding.
  return !result.unknown && result.roots.size === 1 && result.roots.has(BRACES_ADVISORY);
};

const blocking = vulnerabilities.filter((vulnerability) =>
  ["high", "critical"].includes(vulnerability.severity) && !isBracesOnlyChain(vulnerability.name)
);

console.log(
  `Production dependency audit: ${counts.total ?? vulnerabilities.length} advisories ` +
  `(${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low).`
);

if (vulnerabilities.some(isKnownBracesException)) {
  console.warn(
    `SECURITY EXCEPTION until ${BRACES_REVIEW_BY}: ${BRACES_ADVISORY}. ` +
    "No patched braces release is listed upstream; the affected chain is React Native CLI/Metro build tooling. " +
    "Re-review the advisory before the deadline; this exception does not suppress other high/critical findings."
  );
}

if (blocking.length > 0 || (counts.critical ?? 0) > 0) {
  console.error("Blocking high/critical production dependency findings:");
  for (const vulnerability of blocking) {
    console.error(`- ${vulnerability.name}: ${vulnerability.severity} ${(vulnerability.via ?? []).map((via) => typeof via === "object" ? via.title : via).join("; ")}`);
  }
  process.exit(1);
}

if ((audit.status ?? 1) !== 0 && !vulnerabilities.some(isKnownBracesException)) {
  process.stderr.write(audit.stderr || "npm audit failed\n");
  process.exit(audit.status || 1);
}

console.log("Production dependency audit gate passed; unresolved non-blocking advisories remain reported above.");
