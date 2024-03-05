import pkg from 'aws-sdk';
import * as fs from 'fs/promises';
import * as path from 'path';
import extractZip from 'extract-zip';
import cheerio from 'cheerio';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const { S3 } = pkg;
const s3 = new S3();

export const handler = async event => {
  const record = event.Records[0].s3;
  const bucketName = record.bucket.name;
  const objectKey = decodeURIComponent(record.object.key.replace(/\+/g, ' '));
  const zipFileName = objectKey.split('/').pop();
  // zipFilePath를 여기에서 정의하여 함수 전체에서 접근 가능하게 합니다.
  const zipFilePath = path.join('/tmp', zipFileName);
  const tmpFolderPath = path.join('/tmp', zipFileName.replace('.zip', ''));

  const basePath = objectKey.substring(0, objectKey.lastIndexOf('/') + 1); // 예: "static/Test/"

  // ZIP 파일 이름(확장자 제외)을 추가하여 압축 해제된 파일의 기본 경로를 생성합니다.
  const zipBaseName = path.basename(objectKey, '.zip'); // "3_5_4"
  const fullBasePath = `${basePath}${zipBaseName}/`; // "static/Test/3_5_4/"

  try {
    const { Body } = await s3.getObject({ Bucket: bucketName, Key: objectKey }).promise();

    // 스트림을 파일로 쓰기
    if (Body instanceof Buffer) {
      await fs.writeFile(zipFilePath, Body);
    } else {
      await pipeline(Body, createWriteStream(zipFilePath));
    }

    await extractZip(zipFilePath, { dir: tmpFolderPath });
    await processDirectory(tmpFolderPath, bucketName, tmpFolderPath, fullBasePath);

    console.log('All HTML files processed and uploaded successfully.');
  } catch (error) {
    console.error(`Error processing files: ${error}`);
    throw error;
  } finally {
    // 임시 파일 및 폴더 정리
    await fs.rm(tmpFolderPath, { recursive: true, force: true }).catch(console.error);
    await fs.rm(zipFilePath, { force: true }).catch(console.error);
    // 원본 ZIP 파일을 S3에서 삭제
    await s3
      .deleteObject({
        Bucket: bucketName,
        Key: objectKey,
      })
      .promise()
      .then(() => {
        console.log(`Deleted original zip: ${objectKey}`);
      })
      .catch(console.error);
  }
};

async function processDirectory(directory, bucketName, baseFolderPath, fullBasePath) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await processDirectory(fullPath, bucketName, baseFolderPath, fullBasePath);
    } else {
      // 모든 파일을 처리하도록 processFile 함수 호출
      await processFile(fullPath, bucketName, baseFolderPath, fullBasePath);
    }
  }
}

async function processFile(filePath, bucketName, baseFolderPath, fullBasePath) {
  let fileContent = await fs.readFile(filePath);

  // 파일이 HTML인 경우 추가 처리
  if (filePath.endsWith('.html')) {
    const $ = cheerio.load(fileContent.toString());
    $('details').removeAttr('open');
    fileContent = Buffer.from($.html());
  }

  // 파일의 상대 경로를 계산합니다.
  const relativePath = path.relative(baseFolderPath, filePath);
  // S3에 업로드할 때 사용할 Key 값을 설정합니다.
  const s3Key = `${fullBasePath}${relativePath}`;

  await s3
    .putObject({
      Bucket: bucketName,
      Key: s3Key,
      Body: fileContent,
      ContentType: getContentTypeByFile(filePath),
    })
    .promise();

  console.log(`Uploaded: ${s3Key}`);
}

// 파일 확장자에 따라 적절한 Content-Type을 반환하는 함수
function getContentTypeByFile(fileName) {
  const extension = path.extname(fileName).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'application/javascript';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    // 추가적인 파일 유형에 대한 처리를 여기에 포함
    default:
      return 'application/octet-stream';
  }
}
