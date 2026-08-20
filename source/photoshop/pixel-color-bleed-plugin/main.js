const photoshop = require("photoshop");
const { app, core, imaging, constants } = photoshop;

const PROFILE_FALLBACK = "sRGB IEC61966-2.1";
const SHAPE_ALPHA_THRESHOLD = 8;
// Semi-transparent edge pixels can contain matte/undefined RGB values. Only
// nearly solid pixels are allowed to seed the reconstruction and outward bleed.
const COLOR_SEED_ALPHA_THRESHOLD = 200;
// Keep the blend local to a real color gradient. A wider threshold lets
// cream, gray and blue edge pixels form a muddy intermediate band.
const COLOR_MIX_DISTANCE_SQUARED = 90 * 90;
// Color fusion is part of the extension algorithm, not an optional mode.
const ALWAYS_ON_BLEND = 100;
const DIRECTIONS = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1]
];

const $ = (id) => document.getElementById(id);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function setStatus(message, isError) {
    const status = $("status");
    status.textContent = message;
    status.style.color = isError ? "#ff8f8f" : "#b7b7b7";
}

function rgbToHsl(red, green, blue) {
    red /= 255;
    green /= 255;
    blue /= 255;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;
    const delta = max - min;

    if (delta !== 0) {
        saturation = lightness > 0.5
            ? delta / (2 - max - min)
            : delta / (max + min);

        switch (max) {
            case red:
                hue = (green - blue) / delta + (green < blue ? 6 : 0);
                break;
            case green:
                hue = (blue - red) / delta + 2;
                break;
            default:
                hue = (red - green) / delta + 4;
                break;
        }
        hue /= 6;
    }

    return [hue, saturation, lightness];
}

function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

function hslToRgb(hue, saturation, lightness) {
    let red;
    let green;
    let blue;

    if (saturation === 0) {
        red = green = blue = lightness;
    } else {
        const q = lightness < 0.5
            ? lightness * (1 + saturation)
            : lightness + saturation - lightness * saturation;
        const p = 2 * lightness - q;
        red = hueToRgb(p, q, hue + 1 / 3);
        green = hueToRgb(p, q, hue);
        blue = hueToRgb(p, q, hue - 1 / 3);
    }

    return [red * 255, green * 255, blue * 255];
}

function adjustColor(red, green, blue, hue, brightness, saturation) {
    const hsl = rgbToHsl(red, green, blue);
    if (hsl[1] > 0.00001 && hue !== 0) {
        hsl[0] = (hsl[0] + hue / 360 + 1) % 1;
    }
    hsl[1] = clamp(hsl[1] + saturation / 100, 0, 1);
    hsl[2] = clamp(hsl[2] + (brightness / 100) * 0.5, 0, 1);
    return hslToRgb(hsl[0], hsl[1], hsl[2]);
}

function markOutside(occupied, width, height) {
    // Prevent the expansion from filling transparent holes enclosed by the
    // artwork. Only transparent pixels connected to the output border count
    // as the outside region.
    const outside = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    function enqueue(index) {
        if (occupied[index] === 0 && outside[index] === 0) {
            outside[index] = 1;
            queue[tail++] = index;
        }
    }

    let x;
    let y;
    for (x = 0; x < width; x++) {
        enqueue(x);
        enqueue((height - 1) * width + x);
    }
    for (y = 1; y < height - 1; y++) {
        enqueue(y * width);
        enqueue(y * width + width - 1);
    }

    while (head < tail) {
        const index = queue[head++];
        const px = index % width;
        const py = Math.floor(index / width);
        if (px > 0) enqueue(index - 1);
        if (px + 1 < width) enqueue(index + 1);
        if (py > 0) enqueue(index - width);
        if (py + 1 < height) enqueue(index + width);
    }

    return outside;
}

function fillShapeFromReliableSeeds(shape, occupied, origin, output, width, height) {
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    let index;

    for (index = 0; index < occupied.length; index++) {
        if (occupied[index]) {
            origin[index] = index;
            queue[tail++] = index;
        }
    }

    while (head < tail) {
        const pixelIndex = queue[head++];
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        const sourceColor = pixelIndex * 4;

        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }

            const neighborIndex = ny * width + nx;
            if (!shape[neighborIndex] || occupied[neighborIndex]) {
                continue;
            }

            const neighborColor = neighborIndex * 4;
            output[neighborColor] = output[sourceColor];
            output[neighborColor + 1] = output[sourceColor + 1];
            output[neighborColor + 2] = output[sourceColor + 2];
            output[neighborColor + 3] = 255;
            origin[neighborIndex] = origin[pixelIndex];
            occupied[neighborIndex] = 1;
            queue[tail++] = neighborIndex;
        }
    }
}

function reconstructContourColors(output, outside, occupied, reliable, width, height) {
    const pixelCount = width * height;
    const edge = new Uint8Array(pixelCount);
    const sourceColors = new Uint8Array(output);
    const innerColors = new Uint8Array(pixelCount * 3);

    // Identify the actual silhouette edge after low-alpha shape pixels have
    // been reconstructed. This edge is also used as a one-pixel solid bridge
    // between the original artwork and the generated extension.
    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && outside[ny * width + nx]) {
                edge[index] = 1;
                break;
            }
        }
    }

    // A matte or undefined edge pixel can be very different from the color
    // immediately inside the object. Choose the strongest compatible color
    // group from inner neighbors instead of propagating that edge RGB outward.
    for (let index = 0; index < pixelCount; index++) {
        if (!edge[index]) {
            continue;
        }

        const x = index % width;
        const y = Math.floor(index / width);
        const candidates = [];
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }
            const neighborIndex = ny * width + nx;
            if (!occupied[neighborIndex] || edge[neighborIndex]) {
                continue;
            }
            candidates.push(neighborIndex);
        }

        if (candidates.length === 0) {
            const colorIndex = index * 4;
            innerColors[index * 3] = sourceColors[colorIndex];
            innerColors[index * 3 + 1] = sourceColors[colorIndex + 1];
            innerColors[index * 3 + 2] = sourceColors[colorIndex + 2];
            continue;
        }

        let bestCandidate = candidates[0];
        let bestSupport = -1;
        for (let c = 0; c < candidates.length; c++) {
            const candidateColor = candidates[c] * 4;
            let support = 0;
            for (let n = 0; n < candidates.length; n++) {
                const neighborColor = candidates[n] * 4;
                const redDelta = sourceColors[candidateColor] - sourceColors[neighborColor];
                const greenDelta = sourceColors[candidateColor + 1] - sourceColors[neighborColor + 1];
                const blueDelta = sourceColors[candidateColor + 2] - sourceColors[neighborColor + 2];
                if (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta <= COLOR_MIX_DISTANCE_SQUARED) {
                    support++;
                }
            }
            if (support > bestSupport) {
                bestSupport = support;
                bestCandidate = candidates[c];
            }
        }

        const chosenColor = bestCandidate * 4;
        let sumRed = 0;
        let sumGreen = 0;
        let sumBlue = 0;
        let count = 0;
        for (let c = 0; c < candidates.length; c++) {
            const neighborColor = candidates[c] * 4;
            const redDelta = sourceColors[chosenColor] - sourceColors[neighborColor];
            const greenDelta = sourceColors[chosenColor + 1] - sourceColors[neighborColor + 1];
            const blueDelta = sourceColors[chosenColor + 2] - sourceColors[neighborColor + 2];
            if (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta > COLOR_MIX_DISTANCE_SQUARED) {
                continue;
            }
            sumRed += sourceColors[neighborColor];
            sumGreen += sourceColors[neighborColor + 1];
            sumBlue += sourceColors[neighborColor + 2];
            count++;
        }

        if (count > 0) {
            const colorIndex = index * 4;
            if (!reliable[index]) {
                output[colorIndex] = Math.round(sumRed / count);
                output[colorIndex + 1] = Math.round(sumGreen / count);
                output[colorIndex + 2] = Math.round(sumBlue / count);
            }
            innerColors[index * 3] = sourceColors[chosenColor];
            innerColors[index * 3 + 1] = sourceColors[chosenColor + 1];
            innerColors[index * 3 + 2] = sourceColors[chosenColor + 2];
        } else {
            const colorIndex = index * 4;
            innerColors[index * 3] = sourceColors[colorIndex];
            innerColors[index * 3 + 1] = sourceColors[colorIndex + 1];
            innerColors[index * 3 + 2] = sourceColors[colorIndex + 2];
        }
    }

    return {
        edge: edge,
        innerColors: innerColors
    };
}

function buildContourBridge(edge, occupied, width, height) {
    const bridge = new Uint8Array(edge);
    for (let index = 0; index < edge.length; index++) {
        if (!edge[index]) {
            continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }
            const neighborIndex = ny * width + nx;
            if (occupied[neighborIndex]) {
                bridge[neighborIndex] = 1;
            }
        }
    }
    return bridge;
}

function sampleInteriorColor(output, occupied, edgeIndex, normalX, normalY, width, height) {
    const edgeColor = edgeIndex * 4;
    const fallback = [
        output[edgeColor],
        output[edgeColor + 1],
        output[edgeColor + 2]
    ];
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);

    // Walk a few pixels back into the object along the local normal. The
    // first occupied sample is the local gradient anchor for extrapolation.
    for (let step = 1; step <= 5; step++) {
        const sampleX = Math.round(edgeX - normalX * step);
        const sampleY = Math.round(edgeY - normalY * step);
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
            break;
        }
        const sampleIndex = sampleY * width + sampleX;
        if (!occupied[sampleIndex]) {
            continue;
        }
        const sampleColor = sampleIndex * 4;
        return [
            output[sampleColor],
            output[sampleColor + 1],
            output[sampleColor + 2]
        ];
    }

    return fallback;
}

function estimateContourNormal(
    edge,
    outside,
    edgeIndex,
    width,
    height,
    sampleRadius,
    occupiedCenterX,
    occupiedCenterY
) {
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);
    let outwardX = 0;
    let outwardY = 0;
    let tangentWeight = 0;
    let tangentCenterX = 0;
    let tangentCenterY = 0;
    const points = [];

    for (let offsetY = -sampleRadius; offsetY <= sampleRadius; offsetY++) {
        for (let offsetX = -sampleRadius; offsetX <= sampleRadius; offsetX++) {
            const distanceSquared = offsetX * offsetX + offsetY * offsetY;
            if (distanceSquared > sampleRadius * sampleRadius) {
                continue;
            }

            const sampleX = edgeX + offsetX;
            const sampleY = edgeY + offsetY;
            if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
                continue;
            }

            const sampleIndex = sampleY * width + sampleX;
            const weight = 1 / (1 + distanceSquared * 0.2);
            if (outside[sampleIndex]) {
                outwardX += offsetX * weight;
                outwardY += offsetY * weight;
            }
            if (edge[sampleIndex]) {
                points.push([offsetX, offsetY, weight]);
                tangentCenterX += offsetX * weight;
                tangentCenterY += offsetY * weight;
                tangentWeight += weight;
            }
        }
    }

    if (tangentWeight > 0) {
        tangentCenterX /= tangentWeight;
        tangentCenterY /= tangentWeight;
    }

    // Fit a principal tangent to the nearby silhouette pixels. This keeps a
    // curved edge moving along its actual structure rather than quantizing
    // each pixel to a separate horizontal/vertical/diagonal ray.
    let covarianceXX = 0;
    let covarianceXY = 0;
    let covarianceYY = 0;
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
        const point = points[pointIndex];
        const dx = point[0] - tangentCenterX;
        const dy = point[1] - tangentCenterY;
        covarianceXX += dx * dx * point[2];
        covarianceXY += dx * dy * point[2];
        covarianceYY += dy * dy * point[2];
    }

    const tangentMagnitude = covarianceXX + covarianceYY;
    let normalX = outwardX;
    let normalY = outwardY;
    if (tangentMagnitude > 0.5) {
        const tangentAngle = 0.5 * Math.atan2(
            2 * covarianceXY,
            covarianceXX - covarianceYY
        );
        const tangentX = Math.cos(tangentAngle);
        const tangentY = Math.sin(tangentAngle);
        normalX = -tangentY;
        normalY = tangentX;

        // The PCA normal has two possible signs. Use the actual transparent
        // side to choose the outward one.
        if (normalX * outwardX + normalY * outwardY < 0) {
            normalX = -normalX;
            normalY = -normalY;
        }
    }

    let normalLength = Math.sqrt(normalX * normalX + normalY * normalY);
    if (normalLength < 0.001) {
        normalX = edgeX - occupiedCenterX;
        normalY = edgeY - occupiedCenterY;
        normalLength = Math.sqrt(normalX * normalX + normalY * normalY);
    }
    if (normalLength < 0.001) {
        return [0, 0];
    }
    return [normalX / normalLength, normalY / normalLength];
}

function sampleStructureColor(
    output,
    occupied,
    edgeIndex,
    normalX,
    normalY,
    distance,
    width,
    height
) {
    const edgeColor = edgeIndex * 4;
    const fallback = [
        output[edgeColor],
        output[edgeColor + 1],
        output[edgeColor + 2]
    ];
    // Mirror a short distance into the object. This preserves the local
    // highlight/shadow trend while keeping flat color regions unchanged.
    const sampleDepth = distance * 0.65;
    const sampleX = edgeIndex % width - normalX * sampleDepth;
    const sampleY = Math.floor(edgeIndex / width) - normalY * sampleDepth;
    const baseX = Math.floor(sampleX);
    const baseY = Math.floor(sampleY);
    const fractionX = sampleX - baseX;
    const fractionY = sampleY - baseY;
    let sumRed = 0;
    let sumGreen = 0;
    let sumBlue = 0;
    let weightSum = 0;

    for (let offsetY = 0; offsetY <= 1; offsetY++) {
        for (let offsetX = 0; offsetX <= 1; offsetX++) {
            const x = baseX + offsetX;
            const y = baseY + offsetY;
            if (x < 0 || x >= width || y < 0 || y >= height) {
                continue;
            }
            const index = y * width + x;
            if (!occupied[index]) {
                continue;
            }
            const weight = (offsetX ? fractionX : 1 - fractionX) *
                (offsetY ? fractionY : 1 - fractionY);
            if (weight <= 0) {
                continue;
            }
            const colorIndex = index * 4;
            sumRed += output[colorIndex] * weight;
            sumGreen += output[colorIndex + 1] * weight;
            sumBlue += output[colorIndex + 2] * weight;
            weightSum += weight;
        }
    }

    if (weightSum <= 0) {
        return fallback;
    }
    return [
        Math.round(sumRed / weightSum),
        Math.round(sumGreen / weightSum),
        Math.round(sumBlue / weightSum)
    ];
}

function readKnownBilinear(output, occupied, generated, x, y, width, height) {
    if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) {
        return null;
    }
    const baseX = Math.floor(x);
    const baseY = Math.floor(y);
    const fractionX = x - baseX;
    const fractionY = y - baseY;
    let red = 0;
    let green = 0;
    let blue = 0;
    let weightSum = 0;
    for (let offsetY = 0; offsetY <= 1; offsetY++) {
        for (let offsetX = 0; offsetX <= 1; offsetX++) {
            const sampleX = baseX + offsetX;
            const sampleY = baseY + offsetY;
            const sampleIndex = sampleY * width + sampleX;
            if (!occupied[sampleIndex] && !generated[sampleIndex]) {
                continue;
            }
            const weight = (offsetX ? fractionX : 1 - fractionX) *
                (offsetY ? fractionY : 1 - fractionY);
            if (weight <= 0) {
                continue;
            }
            const colorIndex = sampleIndex * 4;
            red += output[colorIndex] * weight;
            green += output[colorIndex + 1] * weight;
            blue += output[colorIndex + 2] * weight;
            weightSum += weight;
        }
    }

    if (weightSum < 0.35) {
        return null;
    }
    return [red / weightSum, green / weightSum, blue / weightSum, weightSum];
}

function estimateColorGuideDirection(
    output,
    occupied,
    edgeIndex,
    normalX,
    normalY,
    width,
    height
) {
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);
    const centerX = edgeX - normalX * 2;
    const centerY = edgeY - normalY * 2;
    let tensorXX = 0;
    let tensorXY = 0;
    let tensorYY = 0;

    for (let offsetY = -6; offsetY <= 6; offsetY++) {
        for (let offsetX = -6; offsetX <= 6; offsetX++) {
            const x = Math.round(centerX + offsetX);
            const y = Math.round(centerY + offsetY);
            if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) {
                continue;
            }
            const index = y * width + x;
            const left = index - 1;
            const right = index + 1;
            const top = index - width;
            const bottom = index + width;
            if (!occupied[index]) {
                continue;
            }

            const leftColor = left * 4;
            const rightColor = right * 4;
            const topColor = top * 4;
            const bottomColor = bottom * 4;
            let redGradientX = 0;
            let greenGradientX = 0;
            let blueGradientX = 0;
            let redGradientY = 0;
            let greenGradientY = 0;
            let blueGradientY = 0;
            let hasHorizontalGradient = false;
            let hasVerticalGradient = false;

            if (occupied[left] && occupied[right]) {
                redGradientX = (output[rightColor] - output[leftColor]) * 0.5;
                greenGradientX = (output[rightColor + 1] - output[leftColor + 1]) * 0.5;
                blueGradientX = (output[rightColor + 2] - output[leftColor + 2]) * 0.5;
                hasHorizontalGradient = true;
            } else if (occupied[right]) {
                redGradientX = output[rightColor] - output[index * 4];
                greenGradientX = output[rightColor + 1] - output[index * 4 + 1];
                blueGradientX = output[rightColor + 2] - output[index * 4 + 2];
                hasHorizontalGradient = true;
            } else if (occupied[left]) {
                redGradientX = output[index * 4] - output[leftColor];
                greenGradientX = output[index * 4 + 1] - output[leftColor + 1];
                blueGradientX = output[index * 4 + 2] - output[leftColor + 2];
                hasHorizontalGradient = true;
            }

            if (occupied[top] && occupied[bottom]) {
                redGradientY = (output[bottomColor] - output[topColor]) * 0.5;
                greenGradientY = (output[bottomColor + 1] - output[topColor + 1]) * 0.5;
                blueGradientY = (output[bottomColor + 2] - output[topColor + 2]) * 0.5;
                hasVerticalGradient = true;
            } else if (occupied[bottom]) {
                redGradientY = output[bottomColor] - output[index * 4];
                greenGradientY = output[bottomColor + 1] - output[index * 4 + 1];
                blueGradientY = output[bottomColor + 2] - output[index * 4 + 2];
                hasVerticalGradient = true;
            } else if (occupied[top]) {
                redGradientY = output[index * 4] - output[topColor];
                greenGradientY = output[index * 4 + 1] - output[topColor + 1];
                blueGradientY = output[index * 4 + 2] - output[topColor + 2];
                hasVerticalGradient = true;
            }

            if (!hasHorizontalGradient && !hasVerticalGradient) {
                continue;
            }
            const gradientMagnitude = redGradientX * redGradientX +
                greenGradientX * greenGradientX + blueGradientX * blueGradientX +
                redGradientY * redGradientY + greenGradientY * greenGradientY +
                blueGradientY * blueGradientY;
            if (gradientMagnitude < 4) {
                continue;
            }
            const distanceSquared = offsetX * offsetX + offsetY * offsetY;
            const weight = gradientMagnitude / (1 + distanceSquared * 0.2);
            tensorXX += weight * (redGradientX * redGradientX +
                greenGradientX * greenGradientX + blueGradientX * blueGradientX);
            tensorXY += weight * (redGradientX * redGradientY +
                greenGradientX * greenGradientY + blueGradientX * blueGradientY);
            tensorYY += weight * (redGradientY * redGradientY +
                greenGradientY * greenGradientY + blueGradientY * blueGradientY);
        }
    }

    const tensorTrace = tensorXX + tensorYY;
    const discriminant = Math.sqrt(
        Math.max(0, (tensorXX - tensorYY) * (tensorXX - tensorYY) + 4 * tensorXY * tensorXY)
    );
    const coherence = tensorTrace > 0 ? discriminant / tensorTrace : 0;
    if (tensorTrace < 100 || coherence < 0.12) {
        return [-normalY, normalX];
    }

    // The dominant eigenvector is the color gradient. The continuation path
    // follows its perpendicular, i.e. the local color contour/isophote.
    const gradientAngle = 0.5 * Math.atan2(2 * tensorXY, tensorXX - tensorYY);
    let tangentX = -Math.sin(gradientAngle);
    let tangentY = Math.cos(gradientAngle);
    const silhouetteTangentX = -normalY;
    const silhouetteTangentY = normalX;
    if (tangentX * silhouetteTangentX + tangentY * silhouetteTangentY < 0) {
        tangentX = -tangentX;
        tangentY = -tangentY;
    }

    // Keep weak/ambiguous color gradients from abruptly rotating the guide.
    // A coherent color boundary is stronger evidence than the silhouette
    // tangent. Only ambiguous/low-coherence neighborhoods fall back toward
    // the outer contour direction.
    const guideWeight = 1;
    const blendedX = silhouetteTangentX * (1 - guideWeight) + tangentX * guideWeight;
    const blendedY = silhouetteTangentY * (1 - guideWeight) + tangentY * guideWeight;
    const length = Math.sqrt(blendedX * blendedX + blendedY * blendedY);
    return length > 0.001
        ? [blendedX / length, blendedY / length]
        : [silhouetteTangentX, silhouetteTangentY];
}

function getCentralColorGradientMagnitude(output, occupied, index, width) {
    const left = index - 1;
    const right = index + 1;
    const top = index - width;
    const bottom = index + width;
    if (!occupied[index] || !occupied[left] || !occupied[right] ||
        !occupied[top] || !occupied[bottom]) {
        return 0;
    }

    const leftColor = left * 4;
    const rightColor = right * 4;
    const topColor = top * 4;
    const bottomColor = bottom * 4;
    let magnitude = 0;
    for (let channel = 0; channel < 3; channel++) {
        const gradientX = (output[rightColor + channel] - output[leftColor + channel]) * 0.5;
        const gradientY = (output[bottomColor + channel] - output[topColor + channel]) * 0.5;
        magnitude += gradientX * gradientX + gradientY * gradientY;
    }
    return magnitude;
}

function estimateBoundaryCurveDirection(
    output,
    occupied,
    edgeIndex,
    normalX,
    normalY,
    width,
    height
) {
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);
    const centerX = edgeX - normalX * 2;
    const centerY = edgeY - normalY * 2;
    const searchRadius = 8;
    let maximumGradient = 0;

    for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY++) {
        for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX++) {
            const x = Math.round(centerX + offsetX);
            const y = Math.round(centerY + offsetY);
            if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) {
                continue;
            }
            const inwardDepth = -(x - edgeX) * normalX - (y - edgeY) * normalY;
            if (inwardDepth < 1.5) {
                continue;
            }
            maximumGradient = Math.max(
                maximumGradient,
                getCentralColorGradientMagnitude(output, occupied, y * width + x, width)
            );
        }
    }

    if (maximumGradient < 64) {
        return null;
    }

    const threshold = Math.max(64, maximumGradient * 0.22);
    let centerWeight = 0;
    let pointCenterX = 0;
    let pointCenterY = 0;
    let pointCount = 0;
    for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY++) {
        for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX++) {
            const x = Math.round(centerX + offsetX);
            const y = Math.round(centerY + offsetY);
            if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) {
                continue;
            }
            const inwardDepth = -(x - edgeX) * normalX - (y - edgeY) * normalY;
            if (inwardDepth < 1.5) {
                continue;
            }
            const magnitude = getCentralColorGradientMagnitude(
                output,
                occupied,
                y * width + x,
                width
            );
            if (magnitude < threshold) {
                continue;
            }
            const distanceSquared = offsetX * offsetX + offsetY * offsetY;
            const weight = magnitude / (1 + distanceSquared * 0.1);
            pointCenterX += x * weight;
            pointCenterY += y * weight;
            centerWeight += weight;
            pointCount++;
        }
    }

    if (pointCount < 4 || centerWeight <= 0) {
        return null;
    }
    pointCenterX /= centerWeight;
    pointCenterY /= centerWeight;

    let covarianceXX = 0;
    let covarianceXY = 0;
    let covarianceYY = 0;
    for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY++) {
        for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX++) {
            const x = Math.round(centerX + offsetX);
            const y = Math.round(centerY + offsetY);
            if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) {
                continue;
            }
            const inwardDepth = -(x - edgeX) * normalX - (y - edgeY) * normalY;
            if (inwardDepth < 1.5) {
                continue;
            }
            const magnitude = getCentralColorGradientMagnitude(
                output,
                occupied,
                y * width + x,
                width
            );
            if (magnitude < threshold) {
                continue;
            }
            const distanceSquared = offsetX * offsetX + offsetY * offsetY;
            const weight = magnitude / (1 + distanceSquared * 0.1);
            const dx = x - pointCenterX;
            const dy = y - pointCenterY;
            covarianceXX += dx * dx * weight;
            covarianceXY += dx * dy * weight;
            covarianceYY += dy * dy * weight;
        }
    }

    const trace = covarianceXX + covarianceYY;
    const discriminant = Math.sqrt(
        Math.max(0, (covarianceXX - covarianceYY) * (covarianceXX - covarianceYY) +
            4 * covarianceXY * covarianceXY)
    );
    const coherence = trace > 0 ? discriminant / trace : 0;
    if (trace < 1 || coherence < 0.5) {
        return null;
    }

    const tangentAngle = 0.5 * Math.atan2(
        2 * covarianceXY,
        covarianceXX - covarianceYY
    );
    let tangentX = Math.cos(tangentAngle);
    let tangentY = Math.sin(tangentAngle);
    const curveNormalX = -tangentY;
    const curveNormalY = tangentX;
    const lineDistance = Math.abs(
        (edgeX - pointCenterX) * curveNormalX +
        (edgeY - pointCenterY) * curveNormalY
    );
    if (lineDistance > 4.5) {
        return null;
    }
    const silhouetteTangentX = -normalY;
    const silhouetteTangentY = normalX;
    if (tangentX * silhouetteTangentX + tangentY * silhouetteTangentY < 0) {
        tangentX = -tangentX;
        tangentY = -tangentY;
    }
    return [tangentX, tangentY];
}

function smoothBoundaryCurveGuides(
    edge,
    curveGuided,
    guideX,
    guideY,
    width,
    height
) {
    const smoothedX = new Float32Array(guideX);
    const smoothedY = new Float32Array(guideY);
    const radius = 3;

    for (let index = 0; index < edge.length; index++) {
        if (!edge[index] || !curveGuided[index]) {
            continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        const baseX = guideX[index];
        const baseY = guideY[index];
        let sumX = baseX;
        let sumY = baseY;
        let weightSum = 1;

        for (let offsetY = -radius; offsetY <= radius; offsetY++) {
            for (let offsetX = -radius; offsetX <= radius; offsetX++) {
                if (offsetX === 0 && offsetY === 0) {
                    continue;
                }
                const nx = x + offsetX;
                const ny = y + offsetY;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const neighborIndex = ny * width + nx;
                if (!edge[neighborIndex] || !curveGuided[neighborIndex]) {
                    continue;
                }
                let neighborX = guideX[neighborIndex];
                let neighborY = guideY[neighborIndex];
                let alignment = neighborX * baseX + neighborY * baseY;
                if (alignment < 0) {
                    neighborX = -neighborX;
                    neighborY = -neighborY;
                    alignment = -alignment;
                }
                if (alignment < 0.65) {
                    continue;
                }
                const distanceSquared = offsetX * offsetX + offsetY * offsetY;
                const weight = 1 / (1 + distanceSquared * 0.35);
                sumX += neighborX * weight;
                sumY += neighborY * weight;
                weightSum += weight;
            }
        }

        const length = Math.sqrt(sumX * sumX + sumY * sumY);
        if (weightSum > 1 && length > 0.001) {
            smoothedX[index] = sumX / length;
            smoothedY[index] = sumY / length;
        }
    }

    guideX.set(smoothedX);
    guideY.set(smoothedY);
}

function sampleGuidedStructureColor(
    output,
    occupied,
    generated,
    targetX,
    targetY,
    edgeIndex,
    guideX,
    guideY,
    normalX,
    normalY,
    depth,
    width,
    height
) {
    const fallback = sampleStructureColor(
        output,
        occupied,
        edgeIndex,
        normalX,
        normalY,
        depth,
        width,
        height
    );
    let red = 0;
    let green = 0;
    let blue = 0;
    let weightSum = 0;

    // Rotated samples are the lightweight equivalent of Guidefill's ghost
    // pixels. q is perpendicular to the contour and s follows it.
    for (let s = -5; s <= 5; s++) {
        for (let q = -2; q <= 2; q++) {
            if (s === 0 && q === 0) {
                continue;
            }
            const sampleX = targetX + guideX * s - guideY * q;
            const sampleY = targetY + guideY * s + guideX * q;
            const sample = readKnownBilinear(
                output,
                occupied,
                generated,
                sampleX,
                sampleY,
                width,
                height
            );
            if (!sample) {
                continue;
            }
            const perpendicularWeight = Math.exp(-0.9 * q * q);
            const distanceWeight = 1 / (0.75 + Math.abs(s) + Math.abs(q) * 0.5);
            const inward = -(sampleX - targetX) * normalX - (sampleY - targetY) * normalY;
            const inwardWeight = inward > 0 ? 1.2 : 1;
            const weight = sample[3] * perpendicularWeight * distanceWeight * inwardWeight;
            red += sample[0] * weight;
            green += sample[1] * weight;
            blue += sample[2] * weight;
            weightSum += weight;
        }
    }

    if (weightSum < 0.5) {
        return fallback;
    }
    return [
        Math.round(red / weightSum),
        Math.round(green / weightSum),
        Math.round(blue / weightSum)
    ];
}

function extrapolateNormalColor(
    output,
    occupied,
    edgeIndex,
    targetIndex,
    distance,
    width,
    height
) {
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);
    const targetX = targetIndex % width;
    const targetY = Math.floor(targetIndex / width);
    let normalX = targetX - edgeX;
    let normalY = targetY - edgeY;
    const length = Math.sqrt(normalX * normalX + normalY * normalY);
    if (length > 0) {
        normalX /= length;
        normalY /= length;
    }

    const edgeColor = edgeIndex * 4;
    const inner = sampleInteriorColor(
        output,
        occupied,
        edgeIndex,
        normalX,
        normalY,
        width,
        height
    );
    const trendAmount = clamp(distance * 0.18, 0, 0.65);
    return [
        clamp(Math.round(output[edgeColor] + (output[edgeColor] - inner[0]) * trendAmount), 0, 255),
        clamp(Math.round(output[edgeColor + 1] + (output[edgeColor + 1] - inner[1]) * trendAmount), 0, 255),
        clamp(Math.round(output[edgeColor + 2] + (output[edgeColor + 2] - inner[2]) * trendAmount), 0, 255)
    ];
}

function propagateNormalExtrusion(
    output,
    outside,
    occupied,
    origin,
    generated,
    width,
    height,
    radius,
    blend
) {
    const pixelCount = width * height;
    const edge = new Uint8Array(pixelCount);
    const distance = new Int16Array(pixelCount);
    distance.fill(-1);
    origin.fill(-1);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && outside[ny * width + nx]) {
                edge[index] = 1;
                distance[index] = 0;
                origin[index] = index;
                queue[tail++] = index;
                break;
            }
        }
    }

    const bridge = buildContourBridge(edge, occupied, width, height);

    while (head < tail) {
        const pixelIndex = queue[head++];
        const currentDistance = distance[pixelIndex];
        if (currentDistance >= radius) {
            continue;
        }

        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }

            const neighborIndex = ny * width + nx;
            if (!outside[neighborIndex]) {
                continue;
            }

            const nextDistance = currentDistance + 1;
            if (distance[neighborIndex] === -1) {
                distance[neighborIndex] = nextDistance;
                origin[neighborIndex] = origin[pixelIndex];
                const color = extrapolateNormalColor(
                    output,
                    occupied,
                    origin[pixelIndex],
                    neighborIndex,
                    nextDistance,
                    width,
                    height
                );
                const outputIndex = neighborIndex * 4;
                output[outputIndex] = color[0];
                output[outputIndex + 1] = color[1];
                output[outputIndex + 2] = color[2];
                output[outputIndex + 3] = 255;
                generated[neighborIndex] = 1;
                queue[tail++] = neighborIndex;
                continue;
            }

            if (distance[neighborIndex] !== nextDistance || blend <= 0) {
                continue;
            }

            const candidate = extrapolateNormalColor(
                output,
                occupied,
                origin[pixelIndex],
                neighborIndex,
                nextDistance,
                width,
                height
            );
            const outputIndex = neighborIndex * 4;
            const redDelta = candidate[0] - output[outputIndex];
            const greenDelta = candidate[1] - output[outputIndex + 1];
            const blueDelta = candidate[2] - output[outputIndex + 2];
            const colorDistanceSquared =
                redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
            if (colorDistanceSquared > COLOR_MIX_DISTANCE_SQUARED) {
                continue;
            }

            const mixAmount = 0.25 * (blend / 100);
            output[outputIndex] = Math.round(output[outputIndex] + redDelta * mixAmount);
            output[outputIndex + 1] = Math.round(output[outputIndex + 1] + greenDelta * mixAmount);
            output[outputIndex + 2] = Math.round(output[outputIndex + 2] + blueDelta * mixAmount);
        }
    }

    return bridge;
}

function propagateForwardColorBand(
    output,
    outside,
    occupied,
    origin,
    generated,
    width,
    height,
    radius,
    blend
) {
    const pixelCount = width * height;
    const edge = new Uint8Array(pixelCount);
    const coverage = new Float32Array(pixelCount);
    let occupiedCount = 0;
    let occupiedCenterX = 0;
    let occupiedCenterY = 0;

    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }
        occupiedCenterX += index % width;
        occupiedCenterY += Math.floor(index / width);
        occupiedCount++;
    }
    if (occupiedCount > 0) {
        occupiedCenterX /= occupiedCount;
        occupiedCenterY /= occupiedCount;
    }

    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && outside[ny * width + nx]) {
                edge[index] = 1;
                origin[index] = index;
                break;
            }
        }
    }

    const bridge = buildContourBridge(edge, occupied, width, height);
    const normalSampleRadius = clamp(Math.round(radius / 5) + 2, 3, 6);

    for (let edgeIndex = 0; edgeIndex < pixelCount; edgeIndex++) {
        if (!edge[edgeIndex]) {
            continue;
        }

        const edgeX = edgeIndex % width;
        const edgeY = Math.floor(edgeIndex / width);
        const normal = estimateContourNormal(
            edge,
            outside,
            edgeIndex,
            width,
            height,
            normalSampleRadius,
            occupiedCenterX,
            occupiedCenterY
        );
        const normalX = normal[0];
        const normalY = normal[1];
        if (normalX === 0 && normalY === 0) {
            continue;
        }

        const edgeColor = edgeIndex * 4;

        for (let distance = 1; distance <= radius; distance++) {
            const targetX = edgeX + normalX * distance;
            const targetY = edgeY + normalY * distance;
            const baseX = Math.floor(targetX);
            const baseY = Math.floor(targetY);
            const fractionX = targetX - baseX;
            const fractionY = targetY - baseY;
            const structureColor = sampleStructureColor(
                output,
                occupied,
                edgeIndex,
                normalX,
                normalY,
                distance,
                width,
                height
            );
            const red = structureColor[0];
            const green = structureColor[1];
            const blue = structureColor[2];

            for (let oy = 0; oy <= 1; oy++) {
                for (let ox = 0; ox <= 1; ox++) {
                    const x = baseX + ox;
                    const y = baseY + oy;
                    if (x < 0 || x >= width || y < 0 || y >= height) {
                        continue;
                    }
                    const weight = (ox ? fractionX : 1 - fractionX) *
                        (oy ? fractionY : 1 - fractionY);
                    if (weight <= 0) {
                        continue;
                    }

                    const targetIndex = y * width + x;
                    if (!outside[targetIndex]) {
                        continue;
                    }

                    const targetColor = targetIndex * 4;
                    if (!generated[targetIndex]) {
                        output[targetColor] = red;
                        output[targetColor + 1] = green;
                        output[targetColor + 2] = blue;
                        output[targetColor + 3] = 255;
                        origin[targetIndex] = edgeIndex;
                        generated[targetIndex] = 1;
                        coverage[targetIndex] = weight;
                        continue;
                    }

                    const redDelta = red - output[targetColor];
                    const greenDelta = green - output[targetColor + 1];
                    const blueDelta = blue - output[targetColor + 2];
                    const colorDistanceSquared =
                        redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
                    if (colorDistanceSquared > COLOR_MIX_DISTANCE_SQUARED) {
                        // At a color boundary, the projection closest to the
                        // pixel center wins. This removes iteration-order wedges.
                        if (weight > coverage[targetIndex]) {
                            output[targetColor] = red;
                            output[targetColor + 1] = green;
                            output[targetColor + 2] = blue;
                            origin[targetIndex] = edgeIndex;
                            coverage[targetIndex] = weight;
                        }
                        continue;
                    }

                    const oldWeight = coverage[targetIndex];
                    const mixAmount = clamp(
                        (weight / Math.max(oldWeight + weight, 0.0001)) * (blend / 100),
                        0,
                        0.5
                    );
                    output[targetColor] = Math.round(output[targetColor] + redDelta * mixAmount);
                    output[targetColor + 1] = Math.round(output[targetColor + 1] + greenDelta * mixAmount);
                    output[targetColor + 2] = Math.round(output[targetColor + 2] + blueDelta * mixAmount);
                    coverage[targetIndex] = oldWeight + weight;
                    if (weight > oldWeight) {
                        origin[targetIndex] = edgeIndex;
                    }
                }
            }
        }
    }

    fillForwardProjectionGaps(
        output,
        outside,
        occupied,
        origin,
        generated,
        coverage,
        width,
        height,
        radius
    );

    return bridge;
}

function buildExpansionBand(outside, occupied, generated, width, height, radius) {
    const pixelCount = width * height;
    const infinity = 0x3fffffff;
    const distance = new Int32Array(pixelCount);
    const band = new Uint8Array(pixelCount);
    distance.fill(infinity);

    for (let index = 0; index < pixelCount; index++) {
        if (occupied[index]) {
            distance[index] = 0;
        }
    }

    // A 3/4 chamfer distance is a close, linear-time approximation of a
    // circular pixel dilation. It defines where gap repair is allowed.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            let best = distance[index];
            if (x > 0) best = Math.min(best, distance[index - 1] + 3);
            if (y > 0) best = Math.min(best, distance[index - width] + 3);
            if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + 4);
            if (x + 1 < width && y > 0) best = Math.min(best, distance[index - width + 1] + 4);
            distance[index] = best;
        }
    }
    for (let y = height - 1; y >= 0; y--) {
        for (let x = width - 1; x >= 0; x--) {
            const index = y * width + x;
            let best = distance[index];
            if (x + 1 < width) best = Math.min(best, distance[index + 1] + 3);
            if (y + 1 < height) best = Math.min(best, distance[index + width] + 3);
            if (x + 1 < width && y + 1 < height) best = Math.min(best, distance[index + width + 1] + 4);
            if (x > 0 && y + 1 < height) best = Math.min(best, distance[index + width - 1] + 4);
            distance[index] = best;
        }
    }

    const maximumDistance = radius * 3;
    for (let index = 0; index < pixelCount; index++) {
        if (generated[index] || (outside[index] && distance[index] <= maximumDistance)) {
            band[index] = 1;
        }
    }
    return band;
}

function fillForwardProjectionGaps(
    output,
    outside,
    occupied,
    origin,
    generated,
    coverage,
    width,
    height,
    radius
) {
    const pixelCount = width * height;
    const band = buildExpansionBand(outside, occupied, generated, width, height, radius);
    const fillDistance = new Int16Array(pixelCount);
    fillDistance.fill(-1);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    for (let index = 0; index < pixelCount; index++) {
        if (generated[index]) {
            fillDistance[index] = 0;
            queue[tail++] = index;
        }
    }

    // Process complete wavefronts. Every repaired pixel can then consider all
    // equally near projected parents instead of depending on queue order.
    let layerStart = 0;
    let layerEnd = tail;
    let currentDistance = 0;
    while (layerStart < layerEnd) {
        for (let queueIndex = layerStart; queueIndex < layerEnd; queueIndex++) {
            const index = queue[queueIndex];
            const x = index % width;
            const y = Math.floor(index / width);
            for (let d = 0; d < DIRECTIONS.length; d++) {
                const nx = x + DIRECTIONS[d][0];
                const ny = y + DIRECTIONS[d][1];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const neighborIndex = ny * width + nx;
                if (!band[neighborIndex] || !outside[neighborIndex] ||
                    fillDistance[neighborIndex] !== -1) {
                    continue;
                }
                fillDistance[neighborIndex] = currentDistance + 1;
                queue[tail++] = neighborIndex;
            }
        }

        const nextLayerEnd = tail;
        for (let queueIndex = layerEnd; queueIndex < nextLayerEnd; queueIndex++) {
            const index = queue[queueIndex];
            const x = index % width;
            const y = Math.floor(index / width);
            const candidates = [];

            for (let d = 0; d < DIRECTIONS.length; d++) {
                const nx = x + DIRECTIONS[d][0];
                const ny = y + DIRECTIONS[d][1];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const neighborIndex = ny * width + nx;
                if (fillDistance[neighborIndex] >= 0 &&
                    fillDistance[neighborIndex] < fillDistance[index]) {
                    candidates.push(neighborIndex);
                }
            }

            if (candidates.length === 0) {
                continue;
            }

            let bestCandidate = candidates[0];
            let bestScore = -1;
            for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
                const candidate = candidates[candidateIndex];
                const candidateColor = candidate * 4;
                let support = 0;
                for (let otherIndex = 0; otherIndex < candidates.length; otherIndex++) {
                    const otherColor = candidates[otherIndex] * 4;
                    const redDelta = output[candidateColor] - output[otherColor];
                    const greenDelta = output[candidateColor + 1] - output[otherColor + 1];
                    const blueDelta = output[candidateColor + 2] - output[otherColor + 2];
                    if (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta <=
                        COLOR_MIX_DISTANCE_SQUARED) {
                        support++;
                    }
                }
                const score = support * 10 + coverage[candidate];
                if (score > bestScore) {
                    bestScore = score;
                    bestCandidate = candidate;
                }
            }

            const bestColor = bestCandidate * 4;
            let sumRed = 0;
            let sumGreen = 0;
            let sumBlue = 0;
            let weightSum = 0;
            for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
                const candidate = candidates[candidateIndex];
                const candidateColor = candidate * 4;
                const redDelta = output[candidateColor] - output[bestColor];
                const greenDelta = output[candidateColor + 1] - output[bestColor + 1];
                const blueDelta = output[candidateColor + 2] - output[bestColor + 2];
                if (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta >
                    COLOR_MIX_DISTANCE_SQUARED) {
                    continue;
                }
                const weight = Math.max(coverage[candidate], 0.05);
                sumRed += output[candidateColor] * weight;
                sumGreen += output[candidateColor + 1] * weight;
                sumBlue += output[candidateColor + 2] * weight;
                weightSum += weight;
            }

            const outputIndex = index * 4;
            output[outputIndex] = Math.round(sumRed / weightSum);
            output[outputIndex + 1] = Math.round(sumGreen / weightSum);
            output[outputIndex + 2] = Math.round(sumBlue / weightSum);
            output[outputIndex + 3] = 255;
            origin[index] = origin[bestCandidate];
            coverage[index] = Math.max(coverage[bestCandidate] * 0.95, 0.01);
            generated[index] = 1;
        }

        layerStart = layerEnd;
        layerEnd = nextLayerEnd;
        currentDistance++;
    }
}

function propagateDirectionalColors(
    output,
    outside,
    occupied,
    origin,
    generated,
    width,
    height,
    radius,
    blend,
    contourInnerColors
) {
    const pixelCount = width * height;
    const distance = new Int16Array(pixelCount);
    distance.fill(-1);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;
    let index;

    // Start from the actual silhouette edge. A breadth-first wave then
    // carries each edge color outward along its shortest local direction.
    for (index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }

        const x = index % width;
        const y = Math.floor(index / width);
        let isEdge = false;
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && outside[ny * width + nx]) {
                isEdge = true;
                break;
            }
        }

        if (isEdge) {
            distance[index] = 0;
            queue[tail++] = index;
        }
    }

    while (head < tail) {
        const pixelIndex = queue[head++];
        const currentDistance = distance[pixelIndex];
        if (currentDistance >= radius) {
            continue;
        }

        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        const parentColor = pixelIndex * 4;

        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }

            const neighborIndex = ny * width + nx;
            if (!outside[neighborIndex]) {
                continue;
            }

            const nextDistance = currentDistance + 1;
            if (distance[neighborIndex] === -1) {
                distance[neighborIndex] = nextDistance;
                origin[neighborIndex] = origin[pixelIndex];
                const neighborColor = neighborIndex * 4;
                const edgeIndex = origin[pixelIndex];
                const edgeColor = edgeIndex * 4;
                const innerColor = edgeIndex * 3;
                const trendAmount = clamp(nextDistance * 0.18, 0, 0.65);
                output[neighborColor] = clamp(Math.round(
                    output[edgeColor] + (output[edgeColor] - contourInnerColors[innerColor]) * trendAmount
                ), 0, 255);
                output[neighborColor + 1] = clamp(Math.round(
                    output[edgeColor + 1] + (output[edgeColor + 1] - contourInnerColors[innerColor + 1]) * trendAmount
                ), 0, 255);
                output[neighborColor + 2] = clamp(Math.round(
                    output[edgeColor + 2] + (output[edgeColor + 2] - contourInnerColors[innerColor + 2]) * trendAmount
                ), 0, 255);
                output[neighborColor + 3] = 255;
                generated[neighborIndex] = 1;
                queue[tail++] = neighborIndex;
                continue;
            }

            if (distance[neighborIndex] !== nextDistance || blend <= 0) {
                continue;
            }

            // Blend only compatible colors arriving at the same wavefront.
            // This prevents blue/cream or blue/gray regions from turning muddy.
            const neighborColor = neighborIndex * 4;
            const redDelta = output[parentColor] - output[neighborColor];
            const greenDelta = output[parentColor + 1] - output[neighborColor + 1];
            const blueDelta = output[parentColor + 2] - output[neighborColor + 2];
            const colorDistanceSquared =
                redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
            if (colorDistanceSquared > COLOR_MIX_DISTANCE_SQUARED) {
                continue;
            }

            const mixAmount = 0.35 * (blend / 100);
            output[neighborColor] = Math.round(
                output[neighborColor] + redDelta * mixAmount
            );
            output[neighborColor + 1] = Math.round(
                output[neighborColor + 1] + greenDelta * mixAmount
            );
            output[neighborColor + 2] = Math.round(
                output[neighborColor + 2] + blueDelta * mixAmount
            );
        }
    }
}

function softenDirectionalBleed(output, occupied, generated, origin, width, height, radius, blend) {
    if (blend <= 0) {
        return;
    }

    const pixelCount = width * height;
    const sourceColors = new Uint8Array(pixelCount * 3);
    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index] && !generated[index]) {
            continue;
        }
        const sourceIndex = index * 4;
        const colorIndex = index * 3;
        sourceColors[colorIndex] = output[sourceIndex];
        sourceColors[colorIndex + 1] = output[sourceIndex + 1];
        sourceColors[colorIndex + 2] = output[sourceIndex + 2];
    }

    const softRadius = clamp(Math.ceil(Math.min(radius, 16) / 6), 1, 3);
    const strength = 0.55 * (blend / 100);

    // A single small, edge-aware blur softens the pixel stair-step while
    // keeping separate color bands from bleeding into unrelated regions.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelIndex = y * width + x;
            if (!generated[pixelIndex]) {
                continue;
            }

            const centerColor = pixelIndex * 3;
            const centerRed = sourceColors[centerColor];
            const centerGreen = sourceColors[centerColor + 1];
            const centerBlue = sourceColors[centerColor + 2];
            let sumRed = 0;
            let sumGreen = 0;
            let sumBlue = 0;
            let weightSum = 0;

            for (let dy = -softRadius; dy <= softRadius; dy++) {
                for (let dx = -softRadius; dx <= softRadius; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                        continue;
                    }

                    const neighborIndex = ny * width + nx;
                    if (!occupied[neighborIndex] && !generated[neighborIndex]) {
                        continue;
                    }

                    const neighborColor = neighborIndex * 3;
                    const redDelta = sourceColors[neighborColor] - centerRed;
                    const greenDelta = sourceColors[neighborColor + 1] - centerGreen;
                    const blueDelta = sourceColors[neighborColor + 2] - centerBlue;
                    const colorDistanceSquared =
                        redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
                    if (origin[neighborIndex] !== origin[pixelIndex] &&
                        colorDistanceSquared > COLOR_MIX_DISTANCE_SQUARED) {
                        continue;
                    }

                    const weight = 1 / (1 + dx * dx + dy * dy);
                    sumRed += sourceColors[neighborColor] * weight;
                    sumGreen += sourceColors[neighborColor + 1] * weight;
                    sumBlue += sourceColors[neighborColor + 2] * weight;
                    weightSum += weight;
                }
            }

            if (weightSum === 0) {
                continue;
            }

            const outputIndex = pixelIndex * 4;
            output[outputIndex] = Math.round(
                centerRed + (sumRed / weightSum - centerRed) * strength
            );
            output[outputIndex + 1] = Math.round(
                centerGreen + (sumGreen / weightSum - centerGreen) * strength
            );
            output[outputIndex + 2] = Math.round(
                centerBlue + (sumBlue / weightSum - centerBlue) * strength
            );
        }
    }
}

function smoothBleedColors(output, occupied, generated, width, height, radius, blend) {
    if (blend <= 0) {
        return;
    }

    const pixelCount = width * height;
    const temp = new Uint8Array(pixelCount * 3);
    const blurRadius = clamp(Math.ceil(Math.min(radius, 36) / 6), 1, 6);
    const passes = blend >= 67 ? 3 : (blend >= 34 ? 2 : 1);
    const strength = blend / 100;

    for (let pass = 0; pass < passes; pass++) {
        let y;
        let x;

        // Horizontal mask-aware box blur. Sliding sums keep this linear in
        // the number of pixels even for large extension radii.
        for (y = 0; y < height; y++) {
            let left = 0;
            let right = -1;
            let count = 0;
            let sumRed = 0;
            let sumGreen = 0;
            let sumBlue = 0;

            for (x = 0; x < width; x++) {
                const wantedLeft = Math.max(0, x - blurRadius);
                const wantedRight = Math.min(width - 1, x + blurRadius);

                while (right < wantedRight) {
                    right++;
                    const addIndex = y * width + right;
                    if (occupied[addIndex]) {
                        const addColor = addIndex * 4;
                        sumRed += output[addColor];
                        sumGreen += output[addColor + 1];
                        sumBlue += output[addColor + 2];
                        count++;
                    }
                }

                while (left < wantedLeft) {
                    const removeIndex = y * width + left;
                    if (occupied[removeIndex]) {
                        const removeColor = removeIndex * 4;
                        sumRed -= output[removeColor];
                        sumGreen -= output[removeColor + 1];
                        sumBlue -= output[removeColor + 2];
                        count--;
                    }
                    left++;
                }

                const pixelIndex = y * width + x;
                if (occupied[pixelIndex] && count > 0) {
                    const tempIndex = pixelIndex * 3;
                    temp[tempIndex] = Math.round(sumRed / count);
                    temp[tempIndex + 1] = Math.round(sumGreen / count);
                    temp[tempIndex + 2] = Math.round(sumBlue / count);
                }
            }
        }

        // The vertical pass completes a fast 2D blur. Original source
        // pixels remain fixed color anchors; only generated pixels are mixed.
        for (x = 0; x < width; x++) {
            let top = 0;
            let bottom = -1;
            let count = 0;
            let sumRed = 0;
            let sumGreen = 0;
            let sumBlue = 0;

            for (y = 0; y < height; y++) {
                const wantedTop = Math.max(0, y - blurRadius);
                const wantedBottom = Math.min(height - 1, y + blurRadius);

                while (bottom < wantedBottom) {
                    bottom++;
                    const addIndex = bottom * width + x;
                    if (occupied[addIndex]) {
                        const addColor = addIndex * 3;
                        sumRed += temp[addColor];
                        sumGreen += temp[addColor + 1];
                        sumBlue += temp[addColor + 2];
                        count++;
                    }
                }

                while (top < wantedTop) {
                    const removeIndex = top * width + x;
                    if (occupied[removeIndex]) {
                        const removeColor = removeIndex * 3;
                        sumRed -= temp[removeColor];
                        sumGreen -= temp[removeColor + 1];
                        sumBlue -= temp[removeColor + 2];
                        count--;
                    }
                    top++;
                }

                const pixelIndex = y * width + x;
                if (!generated[pixelIndex] || count === 0) {
                    continue;
                }

                const colorIndex = pixelIndex * 4;
                const averageRed = sumRed / count;
                const averageGreen = sumGreen / count;
                const averageBlue = sumBlue / count;
                output[colorIndex] = Math.round(
                    output[colorIndex] + (averageRed - output[colorIndex]) * strength
                );
                output[colorIndex + 1] = Math.round(
                    output[colorIndex + 1] + (averageGreen - output[colorIndex + 1]) * strength
                );
                output[colorIndex + 2] = Math.round(
                    output[colorIndex + 2] + (averageBlue - output[colorIndex + 2]) * strength
                );
            }
        }
    }
}

function sampleScaledStructureColor(
    output,
    occupied,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight
) {
    const baseX = Math.floor(sourceX);
    const baseY = Math.floor(sourceY);
    const fractionX = sourceX - baseX;
    const fractionY = sourceY - baseY;
    let sumRed = 0;
    let sumGreen = 0;
    let sumBlue = 0;
    let weightSum = 0;

    for (let offsetY = 0; offsetY <= 1; offsetY++) {
        for (let offsetX = 0; offsetX <= 1; offsetX++) {
            const x = baseX + offsetX;
            const y = baseY + offsetY;
            if (x < 0 || x >= sourceWidth || y < 0 || y >= sourceHeight) {
                continue;
            }
            const sourceIndex = y * sourceWidth + x;
            if (!occupied[sourceIndex]) {
                continue;
            }

            const weight = (offsetX ? fractionX : 1 - fractionX) *
                (offsetY ? fractionY : 1 - fractionY);
            if (weight <= 0) {
                continue;
            }
            const colorIndex = sourceIndex * 4;
            sumRed += output[colorIndex] * weight;
            sumGreen += output[colorIndex + 1] * weight;
            sumBlue += output[colorIndex + 2] * weight;
            weightSum += weight;
        }
    }

    if (weightSum < 0.04) {
        return null;
    }
    return [
        Math.round(sumRed / weightSum),
        Math.round(sumGreen / weightSum),
        Math.round(sumBlue / weightSum)
    ];
}

function buildStructureScaleBleed(sourceData, sourceWidth, sourceHeight, radius, blend, hue, brightness, saturation) {
    const width = sourceWidth + radius * 2;
    const height = sourceHeight + radius * 2;
    const pixelCount = width * height;
    const output = new Uint8Array(pixelCount * 4);
    const shape = new Uint8Array(pixelCount);
    const occupied = new Uint8Array(pixelCount);
    const reliable = new Uint8Array(pixelCount);
    const origin = new Int32Array(pixelCount);
    const generated = new Uint8Array(pixelCount);
    origin.fill(-1);

    let minX = sourceWidth;
    let minY = sourceHeight;
    let maxX = -1;
    let maxY = -1;
    let maximumAlpha = 0;
    let maximumAlphaSourceIndex = -1;
    let maximumAlphaOutputIndex = -1;
    let seedCount = 0;

    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
            const sourceIndex = (y * sourceWidth + x) * 4;
            const alpha = sourceData[sourceIndex + 3];
            const outputIndex = ((y + radius) * width + x + radius) * 4;
            const pixelIndex = outputIndex / 4;

            if (alpha >= SHAPE_ALPHA_THRESHOLD) {
                shape[pixelIndex] = 1;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
            if (alpha >= COLOR_SEED_ALPHA_THRESHOLD) {
                output[outputIndex] = sourceData[sourceIndex];
                output[outputIndex + 1] = sourceData[sourceIndex + 1];
                output[outputIndex + 2] = sourceData[sourceIndex + 2];
                output[outputIndex + 3] = 255;
                occupied[pixelIndex] = 1;
                reliable[pixelIndex] = 1;
                origin[pixelIndex] = pixelIndex;
                seedCount++;
            }
            if (alpha > maximumAlpha) {
                maximumAlpha = alpha;
                maximumAlphaSourceIndex = sourceIndex;
                maximumAlphaOutputIndex = outputIndex;
            }
        }
    }

    if (seedCount === 0 && maximumAlpha >= SHAPE_ALPHA_THRESHOLD) {
        const pixelIndex = maximumAlphaOutputIndex / 4;
        output[maximumAlphaOutputIndex] = sourceData[maximumAlphaSourceIndex];
        output[maximumAlphaOutputIndex + 1] = sourceData[maximumAlphaSourceIndex + 1];
        output[maximumAlphaOutputIndex + 2] = sourceData[maximumAlphaSourceIndex + 2];
        output[maximumAlphaOutputIndex + 3] = 255;
        occupied[pixelIndex] = 1;
        reliable[pixelIndex] = 1;
        origin[pixelIndex] = pixelIndex;
    }

    if (maxX < minX || maxY < minY) {
        return {data: output, width, height};
    }

    // Replace undefined/matted semi-transparent RGB with nearby solid colors
    // before the structural resampling step.
    fillShapeFromReliableSeeds(shape, occupied, origin, output, width, height);
    const outside = markOutside(occupied, width, height);
    const band = buildExpansionBand(outside, occupied, generated, width, height, radius);
    const objectWidth = Math.max(1, maxX - minX + 1);
    const objectHeight = Math.max(1, maxY - minY + 1);
    const scale = 1 + (radius * 2) / Math.max(1, Math.min(objectWidth, objectHeight));
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;

    // Keep source RGB available for the optional edge-aware softening pass,
    // but leave its alpha transparent because the original layer stays above.
    for (let index = 0; index < pixelCount; index++) {
        if (occupied[index]) {
            output[index * 4 + 3] = 0;
        }
    }

    // Reverse-map each exterior pixel into a uniformly expanded copy of the
    // full structure. This carries internal color boundaries with the object
    // instead of independently shooting the outermost color pixels outward.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const targetIndex = y * width + x;
            if (!band[targetIndex] || !outside[targetIndex]) {
                continue;
            }

            const sourceX = radius + centerX + ((x - radius) - centerX) / scale;
            const sourceY = radius + centerY + ((y - radius) - centerY) / scale;
            const color = sampleScaledStructureColor(
                output,
                occupied,
                sourceX,
                sourceY,
                width,
                height
            );
            if (!color) {
                continue;
            }

            const outputIndex = targetIndex * 4;
            output[outputIndex] = color[0];
            output[outputIndex + 1] = color[1];
            output[outputIndex + 2] = color[2];
            output[outputIndex + 3] = 255;
            generated[targetIndex] = 1;
        }
    }

    softenDirectionalBleed(
        output,
        occupied,
        generated,
        origin,
        width,
        height,
        radius,
        blend
    );

    for (let index = 0; index < pixelCount; index++) {
        if (!generated[index]) {
            output[index * 4 + 3] = 0;
            continue;
        }
        const colorIndex = index * 4;
        const adjusted = adjustColor(
            output[colorIndex],
            output[colorIndex + 1],
            output[colorIndex + 2],
            hue,
            brightness,
            saturation
        );
        output[colorIndex] = clamp(Math.round(adjusted[0]), 0, 255);
        output[colorIndex + 1] = clamp(Math.round(adjusted[1]), 0, 255);
        output[colorIndex + 2] = clamp(Math.round(adjusted[2]), 0, 255);
        output[colorIndex + 3] = 255;
    }

    return {data: output, width, height};
}

function buildNearestEdgeField(edge, outside, band, width, height) {
    const pixelCount = width * height;
    const distance = new Int16Array(pixelCount);
    const label = new Int32Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    distance.fill(-1);
    label.fill(-1);
    let head = 0;
    let tail = 0;

    for (let index = 0; index < pixelCount; index++) {
        if (edge[index]) {
            distance[index] = 0;
            label[index] = index;
            queue[tail++] = index;
        }
    }

    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                continue;
            }
            const neighborIndex = ny * width + nx;
            if (!outside[neighborIndex] || !band[neighborIndex] ||
                distance[neighborIndex] !== -1) {
                continue;
            }
            distance[neighborIndex] = distance[index] + 1;
            label[neighborIndex] = label[index];
            queue[tail++] = neighborIndex;
        }
    }

    return {distance, label};
}

function findStructurePatchColor(
    output,
    occupied,
    generated,
    targetX,
    targetY,
    edgeIndex,
    normalX,
    normalY,
    depth,
    width,
    height
) {
    const edgeX = edgeIndex % width;
    const edgeY = Math.floor(edgeIndex / width);
    const sourceDepth = Math.max(1, depth * 0.72);
    const baseSourceX = edgeX - normalX * sourceDepth;
    const baseSourceY = edgeY - normalY * sourceDepth;
    // A compact patch keeps this practical on large sprites while still
    // comparing the local color direction around the advancing front.
    const patchRadius = 1;
    const searchRadius = 3;
    let bestCost = Infinity;
    let bestIndex = -1;

    for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY++) {
        for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX++) {
            const candidateX = Math.round(baseSourceX + offsetX);
            const candidateY = Math.round(baseSourceY + offsetY);
            if (candidateX < patchRadius || candidateX >= width - patchRadius ||
                candidateY < patchRadius || candidateY >= height - patchRadius) {
                continue;
            }
            const candidateIndex = candidateY * width + candidateX;
            if (!occupied[candidateIndex]) {
                continue;
            }

            let sourceValidCount = 0;
            for (let dy = -patchRadius; dy <= patchRadius; dy++) {
                for (let dx = -patchRadius; dx <= patchRadius; dx++) {
                    if (occupied[(candidateY + dy) * width + candidateX + dx]) {
                        sourceValidCount++;
                    }
                }
            }
            if (sourceValidCount < 5) {
                continue;
            }

            let cost = 0;
            let weightSum = 0;
            for (let dy = -patchRadius; dy <= patchRadius; dy++) {
                for (let dx = -patchRadius; dx <= patchRadius; dx++) {
                    const targetSampleX = targetX + dx;
                    const targetSampleY = targetY + dy;
                    if (targetSampleX < 0 || targetSampleX >= width ||
                        targetSampleY < 0 || targetSampleY >= height) {
                        continue;
                    }
                    const targetSampleIndex = targetSampleY * width + targetSampleX;
                    if (!occupied[targetSampleIndex] && !generated[targetSampleIndex]) {
                        continue;
                    }

                    const sourceSampleIndex = (candidateY + dy) * width + candidateX + dx;
                    if (!occupied[sourceSampleIndex]) {
                        continue;
                    }

                    const targetColor = targetSampleIndex * 4;
                    const sourceColor = sourceSampleIndex * 4;
                    const redDelta = output[targetColor] - output[sourceColor];
                    const greenDelta = output[targetColor + 1] - output[sourceColor + 1];
                    const blueDelta = output[targetColor + 2] - output[sourceColor + 2];
                    const weight = 1 / (1 + dx * dx + dy * dy);
                    cost += (redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta) * weight;
                    weightSum += weight;
                }
            }

            if (weightSum === 0) {
                continue;
            }
            cost /= weightSum;
            const priorX = candidateX - baseSourceX;
            const priorY = candidateY - baseSourceY;
            cost += (priorX * priorX + priorY * priorY) * 220;
            if (cost < bestCost) {
                bestCost = cost;
                bestIndex = candidateIndex;
            }
        }
    }

    if (bestIndex < 0) {
        return sampleStructureColor(
            output,
            occupied,
            edgeIndex,
            normalX,
            normalY,
            depth,
            width,
            height
        );
    }

    const colorIndex = bestIndex * 4;
    return [output[colorIndex], output[colorIndex + 1], output[colorIndex + 2]];
}

function buildLocalStructureBleed(sourceData, sourceWidth, sourceHeight, radius, blend, hue, brightness, saturation) {
    const width = sourceWidth + radius * 2;
    const height = sourceHeight + radius * 2;
    const pixelCount = width * height;
    const output = new Uint8Array(pixelCount * 4);
    const shape = new Uint8Array(pixelCount);
    const occupied = new Uint8Array(pixelCount);
    const reliable = new Uint8Array(pixelCount);
    const origin = new Int32Array(pixelCount);
    const generated = new Uint8Array(pixelCount);
    origin.fill(-1);
    let seedCount = 0;
    let maximumAlpha = 0;
    let maximumAlphaSourceIndex = -1;
    let maximumAlphaOutputIndex = -1;

    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
            const sourceIndex = (y * sourceWidth + x) * 4;
            const outputIndex = ((y + radius) * width + x + radius) * 4;
            const pixelIndex = outputIndex / 4;
            const alpha = sourceData[sourceIndex + 3];

            if (alpha >= SHAPE_ALPHA_THRESHOLD) {
                shape[pixelIndex] = 1;
            }
            if (alpha >= COLOR_SEED_ALPHA_THRESHOLD) {
                output[outputIndex] = sourceData[sourceIndex];
                output[outputIndex + 1] = sourceData[sourceIndex + 1];
                output[outputIndex + 2] = sourceData[sourceIndex + 2];
                output[outputIndex + 3] = 255;
                occupied[pixelIndex] = 1;
                reliable[pixelIndex] = 1;
                origin[pixelIndex] = pixelIndex;
                seedCount++;
            }
            if (alpha > maximumAlpha) {
                maximumAlpha = alpha;
                maximumAlphaSourceIndex = sourceIndex;
                maximumAlphaOutputIndex = outputIndex;
            }
        }
    }

    if (seedCount === 0 && maximumAlpha >= SHAPE_ALPHA_THRESHOLD) {
        const pixelIndex = maximumAlphaOutputIndex / 4;
        output[maximumAlphaOutputIndex] = sourceData[maximumAlphaSourceIndex];
        output[maximumAlphaOutputIndex + 1] = sourceData[maximumAlphaSourceIndex + 1];
        output[maximumAlphaOutputIndex + 2] = sourceData[maximumAlphaSourceIndex + 2];
        output[maximumAlphaOutputIndex + 3] = 255;
        occupied[pixelIndex] = 1;
        reliable[pixelIndex] = 1;
        origin[pixelIndex] = pixelIndex;
    }

    fillShapeFromReliableSeeds(shape, occupied, origin, output, width, height);
    const outside = markOutside(occupied, width, height);
    const band = buildExpansionBand(outside, occupied, generated, width, height, radius);
    const edge = new Uint8Array(pixelCount);
    const occupiedCenter = [0, 0];
    let occupiedCount = 0;

    for (let index = 0; index < pixelCount; index++) {
        if (!occupied[index]) {
            continue;
        }
        occupiedCenter[0] += index % width;
        occupiedCenter[1] += Math.floor(index / width);
        occupiedCount++;
        const x = index % width;
        const y = Math.floor(index / width);
        for (let d = 0; d < DIRECTIONS.length; d++) {
            const nx = x + DIRECTIONS[d][0];
            const ny = y + DIRECTIONS[d][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && outside[ny * width + nx]) {
                edge[index] = 1;
                break;
            }
        }
    }
    if (occupiedCount > 0) {
        occupiedCenter[0] /= occupiedCount;
        occupiedCenter[1] /= occupiedCount;
    }

    const nearest = buildNearestEdgeField(edge, outside, band, width, height);
    const normalRadius = clamp(Math.round(radius / 5) + 2, 3, 6);
    const normalX = new Float32Array(pixelCount);
    const normalY = new Float32Array(pixelCount);
    const guideX = new Float32Array(pixelCount);
    const guideY = new Float32Array(pixelCount);
    const curveGuided = new Uint8Array(pixelCount);
    for (let index = 0; index < pixelCount; index++) {
        if (!edge[index]) {
            continue;
        }
        const normal = estimateContourNormal(
            edge,
            outside,
            index,
            width,
            height,
            normalRadius,
            occupiedCenter[0],
            occupiedCenter[1]
        );
        normalX[index] = normal[0];
        normalY[index] = normal[1];
        const boundaryGuide = estimateBoundaryCurveDirection(
            output,
            occupied,
            index,
            normal[0],
            normal[1],
            width,
            height
        );
        const guide = boundaryGuide || estimateColorGuideDirection(
                output,
                occupied,
                index,
                normal[0],
                normal[1],
                width,
                height
            );
        guideX[index] = guide[0];
        guideY[index] = guide[1];
        if (boundaryGuide) {
            curveGuided[index] = 1;
        }
    }
    smoothBoundaryCurveGuides(edge, curveGuided, guideX, guideY, width, height);

    // Advance in distance layers. The newly generated inner layer is then
    // available as context for the next layer, which makes the extension a
    // coherent outward continuation instead of independent radial streaks.
    const layers = Array.from({length: radius + 1}, () => []);
    for (let index = 0; index < pixelCount; index++) {
        if (!band[index] || !outside[index]) {
            continue;
        }
        const level = nearest.distance[index];
        if (level > 0 && level <= radius) {
            layers[level].push(index);
        }
    }

    for (let level = 1; level <= radius; level++) {
        const layer = layers[level];
        for (let layerIndex = 0; layerIndex < layer.length; layerIndex++) {
            const index = layer[layerIndex];
            const edgeIndex = nearest.label[index];
            if (edgeIndex < 0) {
                continue;
            }

            const targetX = index % width;
            const targetY = Math.floor(index / width);
            const edgeX = edgeIndex % width;
            const edgeY = Math.floor(edgeIndex / width);
            const vectorX = targetX - edgeX;
            const vectorY = targetY - edgeY;
            const projectedDepth = vectorX * normalX[edgeIndex] + vectorY * normalY[edgeIndex];
            const depth = Math.max(1, projectedDepth > 0 ? projectedDepth : Math.hypot(vectorX, vectorY));
            const color = sampleGuidedStructureColor(
                output,
                occupied,
                generated,
                targetX,
                targetY,
                edgeIndex,
                guideX[edgeIndex],
                guideY[edgeIndex],
                normalX[edgeIndex],
                normalY[edgeIndex],
                depth,
                width,
                height
            );
            const outputIndex = index * 4;
            output[outputIndex] = color[0];
            output[outputIndex + 1] = color[1];
            output[outputIndex + 2] = color[2];
            output[outputIndex + 3] = 255;
            origin[index] = edgeIndex;
            generated[index] = 1;
        }
    }

    // Let the extension overlap the reliable source by a couple of pixels.
    // This plugs anti-aliased/transparent matte gaps without changing the
    // source layer's visible pixels when the two layers are composited.
    const overlap = new Uint8Array(pixelCount);
    const overlapRadius = Math.min(2, Math.max(1, radius));
    for (let edgeIndex = 0; edgeIndex < pixelCount; edgeIndex++) {
        if (!edge[edgeIndex]) {
            continue;
        }
        const edgeX = edgeIndex % width;
        const edgeY = Math.floor(edgeIndex / width);
        const nx = normalX[edgeIndex];
        const ny = normalY[edgeIndex];
        if (nx === 0 && ny === 0) {
            continue;
        }
        for (let step = 0; step <= overlapRadius; step++) {
            const x = Math.round(edgeX - nx * step);
            const y = Math.round(edgeY - ny * step);
            if (x < 0 || x >= width || y < 0 || y >= height) {
                continue;
            }
            const index = y * width + x;
            if (!occupied[index]) {
                continue;
            }
            const color = sampleStructureColor(
                output,
                occupied,
                edgeIndex,
                nx,
                ny,
                Math.max(1, step + 1),
                width,
                height
            );
            const outputIndex = index * 4;
            output[outputIndex] = color[0];
            output[outputIndex + 1] = color[1];
            output[outputIndex + 2] = color[2];
            output[outputIndex + 3] = 255;
            overlap[index] = 1;
        }
    }

    // Blur only generated pixels. Original edge RGB is never part of this
    // pass, so a dark or matted source fringe cannot become a visible outline.
    softenDirectionalBleed(
        output,
        new Uint8Array(pixelCount),
        generated,
        origin,
        width,
        height,
        radius,
        blend
    );

    for (let index = 0; index < pixelCount; index++) {
        if (!generated[index] && !overlap[index]) {
            output[index * 4 + 3] = 0;
            continue;
        }
        if (overlap[index] && !generated[index]) {
            output[index * 4 + 3] = 255;
            continue;
        }
        const colorIndex = index * 4;
        const adjusted = adjustColor(
            output[colorIndex],
            output[colorIndex + 1],
            output[colorIndex + 2],
            hue,
            brightness,
            saturation
        );
        output[colorIndex] = clamp(Math.round(adjusted[0]), 0, 255);
        output[colorIndex + 1] = clamp(Math.round(adjusted[1]), 0, 255);
        output[colorIndex + 2] = clamp(Math.round(adjusted[2]), 0, 255);
        output[colorIndex + 3] = 255;
    }

    return {data: output, width, height};
}

function buildBleed(sourceData, sourceWidth, sourceHeight, radius, blend, hue, brightness, saturation) {
    return buildLocalStructureBleed(
        sourceData,
        sourceWidth,
        sourceHeight,
        radius,
        blend,
        hue,
        brightness,
        saturation
    );

    /* Legacy contour-ray implementation retained below for comparison and
       fallback experiments; the structure-preserving path above is active. */
    const width = sourceWidth + radius * 2;
    const height = sourceHeight + radius * 2;
    const pixelCount = width * height;
    const output = new Uint8Array(pixelCount * 4);
    const shape = new Uint8Array(pixelCount);
    const occupied = new Uint8Array(pixelCount);
    const reliable = new Uint8Array(pixelCount);
    const origin = new Int32Array(pixelCount);
    const generated = new Uint8Array(pixelCount);
    origin.fill(-1);
    let seedCount = 0;
    let maximumAlpha = 0;
    let maximumAlphaSourceIndex = -1;
    let maximumAlphaOutputIndex = -1;

    let y;
    let x;
    for (y = 0; y < sourceHeight; y++) {
        for (x = 0; x < sourceWidth; x++) {
            const sourceIndex = (y * sourceWidth + x) * 4;
            const outputIndex = ((y + radius) * width + x + radius) * 4;
            const alpha = sourceData[sourceIndex + 3];
            const pixelIndex = (y + radius) * width + x + radius;

            if (alpha >= SHAPE_ALPHA_THRESHOLD) {
                shape[pixelIndex] = 1;
            }

            if (alpha >= COLOR_SEED_ALPHA_THRESHOLD) {
                output[outputIndex] = sourceData[sourceIndex];
                output[outputIndex + 1] = sourceData[sourceIndex + 1];
                output[outputIndex + 2] = sourceData[sourceIndex + 2];
                output[outputIndex + 3] = 255;
                occupied[pixelIndex] = 1;
                reliable[pixelIndex] = 1;
                seedCount++;
            }

            if (alpha > maximumAlpha) {
                maximumAlpha = alpha;
                maximumAlphaSourceIndex = sourceIndex;
                maximumAlphaOutputIndex = outputIndex;
            }
        }
    }

    // Fully translucent artwork may have no pixel above the normal seed
    // threshold. Use its most visible pixel as a conservative fallback.
    if (seedCount === 0 && maximumAlpha >= SHAPE_ALPHA_THRESHOLD) {
        const pixelIndex = maximumAlphaOutputIndex / 4;
        output[maximumAlphaOutputIndex] = sourceData[maximumAlphaSourceIndex];
        output[maximumAlphaOutputIndex + 1] = sourceData[maximumAlphaSourceIndex + 1];
        output[maximumAlphaOutputIndex + 2] = sourceData[maximumAlphaSourceIndex + 2];
        output[maximumAlphaOutputIndex + 3] = 255;
        occupied[pixelIndex] = 1;
        reliable[pixelIndex] = 1;
        origin[pixelIndex] = pixelIndex;
    }

    // Low-alpha edge RGB is often undefined or matted. Reconstruct those
    // pixels from nearby reliable source colors before any outward dilation.
    fillShapeFromReliableSeeds(shape, occupied, origin, output, width, height);

    const outside = markOutside(occupied, width, height);
    const contourBridge = propagateForwardColorBand(
        output,
        outside,
        occupied,
        origin,
        generated,
        width,
        height,
        radius,
        blend
    );

    softenDirectionalBleed(
        output,
        occupied,
        generated,
        origin,
        width,
        height,
        radius,
        blend
    );

    // Apply the controls once to the final extension colors. This prevents
    // brightness and saturation from accumulating on every dilation step.
    for (let index = 0; index < pixelCount; index++) {
        if (!generated[index]) {
            continue;
        }
        const colorIndex = index * 4;
        const adjusted = adjustColor(
            output[colorIndex],
            output[colorIndex + 1],
            output[colorIndex + 2],
            hue,
            brightness,
            saturation
        );
        output[colorIndex] = clamp(Math.round(adjusted[0]), 0, 255);
        output[colorIndex + 1] = clamp(Math.round(adjusted[1]), 0, 255);
        output[colorIndex + 2] = clamp(Math.round(adjusted[2]), 0, 255);
    }

    // The source layer remains the authority for the original silhouette.
    // Keep reconstructed interior pixels transparent so the generated layer
    // cannot cover anti-aliased source edges with a dark matte/outline.
    for (let index = 0; index < pixelCount; index++) {
        if (!generated[index] && !contourBridge[index]) {
            output[index * 4 + 3] = 0;
        } else {
            output[index * 4 + 3] = 255;
        }
    }

    // Only newly generated pixels receive the user-selected color adjustment
    // and fully opaque alpha.
    return {
        data: output,
        width: width,
        height: height
    };
}

async function runBleed() {
    const radius = clamp(parseInt($("radius").value, 10) || 0, 1, 256);
    const blend = ALWAYS_ON_BLEND;
    // Read the signed numeric fields. The native UXP ranges use non-negative
    // coordinates internally for reliable midpoint initialization.
    const hue = clamp(parseInt($("hueNumber").value, 10) || 0, -180, 180);
    const brightness = clamp(parseInt($("brightnessNumber").value, 10) || 0, -100, 100);
    const saturation = clamp(parseInt($("saturationNumber").value, 10) || 0, -100, 100);
    const shouldExpandCanvas = $("expandCanvas").checked;

    if (!app.activeDocument) {
        throw new Error("请先打开 Photoshop 文档。");
    }

    const documentRef = app.activeDocument;
    const activeLayers = documentRef.activeLayers;
    if (!activeLayers || activeLayers.length === 0) {
        throw new Error("请先选择一个图像图层。");
    }
    const sourceLayer = activeLayers[0];

    await core.executeAsModal(async () => {
        if (shouldExpandCanvas) {
            await documentRef.resizeCanvas(
                documentRef.width + radius * 2,
                documentRef.height + radius * 2
            );
        }

        const documentProfile = documentRef.colorProfileName &&
            documentRef.colorProfileName !== "None"
            ? documentRef.colorProfileName
            : PROFILE_FALLBACK;

        const pixels = await imaging.getPixels({
            documentID: documentRef.id,
            layerID: sourceLayer.id,
            componentSize: 8,
            colorSpace: "RGB",
            colorProfile: documentProfile,
            applyAlpha: false
        });

        const sourceImage = pixels.imageData;
        const sourceData = await sourceImage.getData({chunky: true});
        if (sourceImage.components !== 4) {
            sourceImage.dispose();
            throw new Error("请选择带透明度的 RGB 图像图层。");
        }

        const result = buildBleed(
            sourceData,
            sourceImage.width,
            sourceImage.height,
            radius,
            blend,
            hue,
            brightness,
            saturation
        );

        const sourceBounds = pixels.sourceBounds;
        const imageData = await imaging.createImageDataFromBuffer(result.data, {
            width: result.width,
            height: result.height,
            components: 4,
            chunky: true,
            colorProfile: sourceImage.colorProfile || documentProfile,
            colorSpace: "RGB"
        });

        const outputLayer = await documentRef.createPixelLayer({
            name: sourceLayer.name + " - Solid Color Bleed " + radius + "px"
        });
        outputLayer.move(sourceLayer, constants.ElementPlacement.PLACEAFTER);

        await imaging.putPixels({
            documentID: documentRef.id,
            layerID: outputLayer.id,
            imageData: imageData,
            replace: true,
            targetBounds: {
                left: sourceBounds.left - radius,
                top: sourceBounds.top - radius
            },
            commandName: "Generate Solid Color Bleed"
        });

        imageData.dispose();
        sourceImage.dispose();
        setStatus("完成：已生成实心颜色扩展层。", false);
    }, {commandName: "Generate Solid Color Bleed"});
}

function bindAdjustment(rangeId, numberId, offset) {
    const range = $(rangeId);
    const number = $(numberId);
    const rangeMin = Number(range.min);
    const rangeMax = Number(range.max);
    const numberMin = Number(number.min);
    const numberMax = Number(number.max);

    const toDisplayValue = (rangeValue) => clamp(
        Math.round(Number(rangeValue) - offset),
        numberMin,
        numberMax
    );

    const toRangeValue = (displayValue) => clamp(
        Math.round(Number(displayValue) + offset),
        rangeMin,
        rangeMax
    );

    const setValue = (displayValue) => {
        const value = clamp(Math.round(displayValue), numberMin, numberMax);
        number.value = String(value);
        range.value = String(toRangeValue(value));
    };

    // Explicitly initialize both controls. This avoids UXP restoring a stale
    // endpoint or misreading a signed range on first load.
    const initialValue = Number(number.value);
    setValue(Number.isFinite(initialValue) ? initialValue : 0);

    range.addEventListener("input", () => {
        setValue(toDisplayValue(range.value));
    });

    const syncFromNumber = () => {
        const raw = number.value.trim();
        if (raw === "" || raw === "-") {
            return;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            setValue(toDisplayValue(range.value));
            return;
        }
        setValue(parsed);
    };

    number.addEventListener("input", syncFromNumber);
    number.addEventListener("change", syncFromNumber);
}

bindAdjustment("hue", "hueNumber", 180);
bindAdjustment("saturation", "saturationNumber", 100);
bindAdjustment("brightness", "brightnessNumber", 100);

$("run").addEventListener("click", async () => {
    const button = $("run");
    button.disabled = true;
    setStatus("正在处理像素，请稍候...", false);
    try {
        await runBleed();
    } catch (error) {
        setStatus(error.message || String(error), true);
    } finally {
        button.disabled = false;
    }
});
