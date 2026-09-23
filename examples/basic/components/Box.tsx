import React from "react";

export const Box: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ position: "absolute", left: 0, top: 0, width: 80, height: 80, background: color }} />
);
