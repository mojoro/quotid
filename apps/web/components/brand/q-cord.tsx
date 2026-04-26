const QCORD_PATH = "M 80 140 C 80 70, 140 40, 200 40 C 280 40, 320 100, 320 144 C 320 200, 280 240, 220 240 C 160 240, 88 220, 84 156 C 82 110, 130 84, 178 100 C 226 116, 252 168, 280 196 C 308 224, 332 230, 350 222 C 364 216, 368 202, 358 196 C 348 192, 342 204, 354 212 C 374 224, 396 224, 412 210 C 428 196, 432 178, 422 168 C 412 160, 398 168, 402 180 C 408 196, 432 200, 452 188";

type Props = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

export function QCordMark({ size = 28, strokeWidth = 28, className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 480 280"
      width={size * (480 / 280)}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d={QCORD_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
