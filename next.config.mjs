/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 产出精简的 standalone server，便于 Docker 部署
  output: "standalone",
};

export default nextConfig;
