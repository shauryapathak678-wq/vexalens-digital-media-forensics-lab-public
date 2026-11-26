export interface LsbChannelResult {
  name: 'Red' | 'Green' | 'Blue';
  ones: number;
  total: number;
  oneRatio: number;
  hiddenTextPreview: string;
  printableRatio: number;
}

export interface LsbAnalysisResult {
  channels: LsbChannelResult[];
  planes: {
    red: ImageData;
    green: ImageData;
    blue: ImageData;
  };
  width: number;
  height: number;
}

export function analyzeLsbPixels(imageData: ImageData): LsbAnalysisResult {
  const names = ['Red', 'Green', 'Blue'] as const;
  const planeNames = ['red', 'green', 'blue'] as const;
  const channels: LsbChannelResult[] = [];
  const planes = {
    red: new ImageData(imageData.width, imageData.height),
    green: new ImageData(imageData.width, imageData.height),
    blue: new ImageData(imageData.width, imageData.height),
  };

  planeNames.forEach((name, channelIndex) => {
    let ones = 0;
    const plane = planes[name];
    let printableCharacters = 0;
    let printableBytes = 0;
    const bytes: number[] = [];

    for (let pixel = 0, rgbaIndex = 0; pixel < imageData.width * imageData.height; pixel += 1, rgbaIndex += 4) {
      const lsb = imageData.data[rgbaIndex + channelIndex] & 1;
      if (lsb === 1) ones += 1;
      const grey = lsb === 1 ? 255 : 0;
      plane.data[rgbaIndex] = grey;
      plane.data[rgbaIndex + 1] = grey;
      plane.data[rgbaIndex + 2] = grey;
      plane.data[rgbaIndex + 3] = 255;
    }

    for (let bitIndex = 0; bitIndex + 7 < imageData.width * imageData.height; bitIndex += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const pixel = bitIndex + bit;
        const rgbaIndex = pixel * 4;
        byte |= (imageData.data[rgbaIndex + channelIndex] & 1) << (7 - bit);
      }
      if (byte === 0) continue;
      bytes.push(byte);
    }

    const previewBytes = bytes.slice(0, 160);
    for (const byte of previewBytes) {
      if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
        printableCharacters += 1;
      }
      printableBytes += 1;
    }
    const printableRatio = printableBytes > 0 ? printableCharacters / printableBytes : 0;
    const hiddenTextPreview = String.fromCharCode(...previewBytes)
      .replace(/[^\x20-\x7E\n\r\t]/g, '.')
      .slice(0, 160);

    const total = imageData.width * imageData.height;
    channels.push({
      name: names[channelIndex],
      ones,
      total,
      oneRatio: ones / total,
      hiddenTextPreview,
      printableRatio,
    });
  });

  return { channels, planes, width: imageData.width, height: imageData.height };
}
