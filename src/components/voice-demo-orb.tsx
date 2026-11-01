import { useEffect, useRef, type RefObject } from "react";
import { vertexShader, fragmentShader } from "./voice-demo-shaders";

export function VoiceDemoOrb({ audioLevel }: { audioLevel: RefObject<number> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl");
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      shaders.push(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexShader);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentShader);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      shaders.forEach((s) => gl.deleteShader(s));
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const time = gl.getUniformLocation(program, "u_time");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const pointer = gl.getUniformLocation(program, "u_mouse");
    const amplitude = gl.getUniformLocation(program, "u_audio");
    let smoothed = 0;
    let mouseX = 0.5,
      mouseY = 0.5,
      frame = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = (e.clientX - rect.left) / rect.width;
      mouseY = 1 - (e.clientY - rect.top) / rect.height;
    };
    canvas.addEventListener("pointermove", move);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const render = (t: number) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(time, reduced ? 0 : t * 0.001);
      smoothed += (audioLevel.current - smoothed) * 0.16;
      gl.uniform1f(amplitude, reduced ? 0 : smoothed);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform2f(pointer, mouseX * canvas.width, mouseY * canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(render);
    };
    render(0);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointermove", move);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      shaders.forEach((s) => gl.deleteShader(s));
    };
  }, [audioLevel]);
  return (
    <canvas
      ref={ref}
      className="voice-demo-canvas"
      aria-label="Animated Apero pearl and emerald voice visual"
    />
  );
}
