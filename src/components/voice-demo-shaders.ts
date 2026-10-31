export const vertexShader = `attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
export const fragmentShader = `precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;

// Simplex 3D noise
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0 );
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                dot(p2,x2), dot(p3,x3) ) );
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
    float t = u_time * 0.95;
    
    // Mouse subtle tilt
    vec2 mNorm = (u_mouse / u_resolution) - 0.5;
    uv += mNorm * 0.04;

    float r = length(uv);
    float angle = atan(uv.y, uv.x);

    // Multi-octave organic displacement for fluid Apero pearl/mercury voice orb
    float n1 = snoise(vec3(uv * 2.8, t * 0.8));
    float n2 = snoise(vec3(uv * 5.2 + vec2(t * 0.4, -t * 0.5), t * 0.6));
    float n3 = snoise(vec3(uv * 8.5 - vec2(t * 0.6, t * 0.3), t * 1.1));
    
    float displacement = n1 * 0.065 + n2 * 0.028 + n3 * 0.012;
    float baseRadius = 0.285;
    float orbDist = r - (baseRadius + displacement);

    // Core shape & smooth edge
    float orbAlpha = smoothstep(0.015, -0.015, orbDist);

    // 3D volumetric spherical normal reconstruction
    float zNorm = sqrt(max(0.0, 1.0 - pow(clamp(r / baseRadius, 0.0, 1.0), 2.0)));
    vec3 normal = normalize(vec3(uv.x, uv.y, zNorm + displacement * 1.8));

    // Dynamic dual key-light lighting
    vec3 lightDir1 = normalize(vec3(0.55, 0.75, 1.25));
    vec3 lightDir2 = normalize(vec3(-0.7, -0.5, 0.85));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    float diff1 = max(dot(normal, lightDir1), 0.0);
    float diff2 = max(dot(normal, lightDir2), 0.0);

    // Specular highlights
    vec3 half1 = normalize(lightDir1 + viewDir);
    float spec1 = pow(max(dot(normal, half1), 0.0), 40.0);
    float spec2 = pow(max(dot(normal, normalize(lightDir2 + viewDir)), 0.0), 24.0);

    // Fresnel rim lighting
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5);

    // Distinct luminous color palette: Fluid titanium/pearl core with subtle iridescent emerald-mint sheen
    vec3 deepCore = vec3(0.04, 0.06, 0.08);
    vec3 midSilver = vec3(0.72, 0.78, 0.84);
    vec3 highlightWhite = vec3(0.98, 1.0, 1.0);
    vec3 emeraldTone = vec3(0.18, 0.88, 0.68); // Apero vibrant clinical emerald
    vec3 cyanGlow = vec3(0.25, 0.75, 0.95);

    // Fluid swirl patterns inside the orb
    float swirl = sin(angle * 4.0 + n1 * 3.5 + t * 1.4) * 0.5 + 0.5;
    vec3 innerColor = mix(deepCore, midSilver, diff1 * 0.75 + 0.2);
    innerColor = mix(innerColor, emeraldTone, swirl * 0.32 * fresnel);
    innerColor += cyanGlow * (diff2 * 0.25);
    innerColor += highlightWhite * (spec1 * 0.85 + spec2 * 0.35);
    innerColor += mix(highlightWhite, emeraldTone, 0.4) * (fresnel * 0.75);

    // Atmospheric outer aura / luminous glow
    float glowDist = max(0.0, r - baseRadius);
    float aura = exp(-glowDist * 8.5) * 0.55;
    float outerRing = exp(-pow(r - baseRadius * 1.06, 2.0) * 90.0) * 0.38;
    vec3 glowColor = mix(vec3(0.4, 0.55, 0.75), emeraldTone, 0.45) * (aura + outerRing);

    // Final composite
    vec3 finalColor = mix(glowColor, innerColor, orbAlpha);
    float finalAlpha = clamp(orbAlpha + aura * 0.85 + outerRing * 0.7, 0.0, 1.0);

    // Seamless blend into dark canvas background
    vec3 bgColor = vec3(0.02, 0.024, 0.032);
    gl_FragColor = vec4(mix(bgColor, finalColor, finalAlpha), 1.0);
}`;
