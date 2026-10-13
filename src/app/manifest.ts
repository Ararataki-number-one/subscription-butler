import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return { name: "订阅管家", short_name: "订阅管家", description: "本地经营账本与受控多设备协作", start_url: "/workspace", scope: "/", display: "standalone", lang: "zh-CN",
    background_color: "#f5f9f8", theme_color: "#00795e", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] };
}
