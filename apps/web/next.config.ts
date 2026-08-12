import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // ADR-0005: `@shortkit/contracts` ships TypeScript source with no build step,
  // so the bundler compiles it alongside the app.
  transpilePackages: ['@shortkit/contracts'],
};

export default nextConfig;
