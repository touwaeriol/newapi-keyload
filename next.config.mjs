/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 产出精简的 standalone server，便于 Docker 部署
  output: "standalone",
  // 启用 instrumentation.ts（Next 14.2 需显式开启）以在启动时拉起定时补 key 引擎
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
