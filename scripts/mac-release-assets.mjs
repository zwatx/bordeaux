export function macReleaseArtifactNames(version) {
  const prefix = `Bordeaux-${version}-mac-arm64`;
  return [`${prefix}.dmg`, `${prefix}.zip`];
}

export function verifyMacReleaseAssetNames(names, version) {
  const artifacts = macReleaseArtifactNames(version);
  for (const name of artifacts) {
    if (!names.includes(name)) throw new Error(`Missing macOS release asset: ${name}`);
  }
  const allowed = new Set(artifacts.flatMap((name) => [name, `${name}.blockmap`]));
  for (const name of names) {
    if (/\.(dmg|zip)(\.blockmap)?$/i.test(name) && !allowed.has(name)) {
      throw new Error(`Unexpected macOS release asset for Apple Silicon: ${name}`);
    }
  }
  return artifacts;
}
