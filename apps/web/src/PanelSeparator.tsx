import React from "react";

export function PanelSeparator({ label, orientation, className, value, min, max, onPointerDown, onKeyDown }: {
  label: string;
  orientation: "vertical" | "horizontal";
  className: string;
  value: number;
  min: number;
  max: number;
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  return <div className={`separator ${orientation} ${className}`} role="separator" aria-orientation={orientation} aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}
