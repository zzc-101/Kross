import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
  /** 是否拿到了真实 TTY 尺寸（测试环境常为 false） */
  isTty: boolean;
}

const FALLBACK: TerminalSize = {
  columns: 80,
  rows: 24,
  isTty: false
};

/**
 * 跟踪终端尺寸；resize 时更新，供全屏布局使用。
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    const stream = stdout as NodeJS.WriteStream | undefined;
    if (!stream?.isTTY) {
      setSize(readSize(stream));
      return;
    }

    const onResize = () => setSize(readSize(stream));
    stream.on('resize', onResize);
    onResize();
    return () => {
      stream.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}

function readSize(stdout: { columns?: number; rows?: number; isTTY?: boolean } | undefined): TerminalSize {
  if (!stdout) {
    return FALLBACK;
  }
  const columns = stdout.columns && stdout.columns > 0 ? stdout.columns : FALLBACK.columns;
  const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : FALLBACK.rows;
  return {
    columns,
    rows,
    isTty: Boolean(stdout.isTTY)
  };
}
