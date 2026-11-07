/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Lint errors fail the build (0 errors as of Nov 2026; react-hooks warnings are tolerated).
    ignoreDuringBuilds: false,
  },
  typescript: {
    // Type errors must fail the build (tsc --noEmit is clean as of Phase 12).
    ignoreBuildErrors: false,
  },
};

export default nextConfig;