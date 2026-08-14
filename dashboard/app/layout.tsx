import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Afterlife WhatsApp Dashboard",
  description: "Manage WhatsApp AI agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0f] text-[#f1f1f3] min-h-screen">
        <div className="flex min-h-screen bg-[#0a0a0f]">
          <Sidebar />
          <main className="flex-1 overflow-auto bg-[#0a0a0f] min-h-screen">{children}</main>
        </div>
      </body>
    </html>
  );
}
