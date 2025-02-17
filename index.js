const express = require("express");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const { exec, spawn } = require("child_process");
const AdmZip = require("adm-zip");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());

// 设置存储位置和文件名
const upload = multer({ dest: "uploads/" });

// 创建任务队列和状态跟踪
let taskQueue = [];
let taskStatus = {};

// 添加任务到队列
function addTaskToQueue(task) {
  taskQueue.push(task);
  processQueue();
}

// 处理队列中的任务
async function processQueue() {
  if (taskQueue.length === 0) return;

  const currentTask = taskQueue[0];

  // 更新任务状态为“编译中”
  taskStatus[currentTask.md5].status = "compiling";

  try {
    await compileLaTeX(currentTask);
    taskStatus[currentTask.md5].status = "completed";
    taskStatus[currentTask.md5].pdfFilePath = currentTask.pdfFilePath;
  } catch (error) {
    taskStatus[currentTask.md5].status = "failed";
    console.error(`Error compiling ${currentTask.md5}:`, error);
  }

  // 从队列中移除已完成的任务
  taskQueue.shift();

  // 继续处理下一个任务
  processQueue();
}

async function compileLaTeX(task) {
  return new Promise((resolve, reject) => {
    const command = "latexmk";
    const args = [
      "-pdf",
      "-xelatex",
      `-output-directory=${task.folderPath}`,
      task.texFilePath,
    ];

    // 创建子进程
    const child = spawn(command, args, { cwd: task.folderPath });

    let stdoutData = "";
    let stderrData = "";

    // 收集标准输出数据
    child.stdout.on("data", (data) => {
      console.log(`stdout: ${data}`);
      stdoutData += data;
    });

    // 收集标准错误数据
    child.stderr.on("data", (data) => {
      console.error(`stderr: ${data}`);
      stderrData += data;
    });

    // 子进程结束时触发
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Process exited with code ${code}\n${stderrData}`)
        );
      }
      resolve({ stdout: stdoutData, stderr: stderrData });
    });

    // 子进程出错时触发
    child.on("error", (error) => {
      reject(error);
    });
  });
}

// 清理任务文件
async function cleanupTaskFiles(md5) {
  const task = taskStatus[md5];
  console.log(md5);
  console.log(task);
  console.log(`Cleaning up ${task.folderPath}`);
  if (!task || !task.folderPath) return;

  try {
    // 删除整个任务文件夹
    await fs.rm(task.folderPath, { recursive: true, force: true });
    delete taskStatus[md5];
  } catch (error) {
    console.error(`Failed to clean up files for task ${md5}:`, error);
  }
}

// 展示当前队列的API
app.get("/queue", (req, res) => {
  res.json({
    queue: taskQueue.map((task) => ({
      md5: task.md5,
      status: taskStatus[task.md5]?.status || "unknown",
      folderPath: task.folderPath,
    })),
  });
});

// 保存并解压上传的文件
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }
  try {
    const zipFilePath = req.file.path;
    const folderName = `${req.file.filename}_files`;
    const extractPath = path.join(__dirname, "uploads", folderName);

    // 创建解压目标文件夹
    await fs.mkdir(extractPath, { recursive: true });

    // 解压文件
    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(extractPath, /*overwrite=*/ true);

    // 删除原始上传的压缩文件
    await fs.unlink(zipFilePath);

    // 查找tex文件
    const texFiles = await fs
      .readdir(extractPath)
      .then((files) =>
        files.filter((file) => path.extname(file).toLowerCase() === ".tex")
      );
    if (texFiles.length === 0) {
      throw new Error("No .tex file found in the archive.");
    }

    const texFileName = texFiles[0];
    const texFilePath = path.join(extractPath, texFileName);
    const pdfFilePath = path.join(
      extractPath,
      `${path.basename(texFileName, ".tex")}.pdf`
    );

    // 生成MD5标识符
    const md5 = crypto.createHash("md5").update(uuidv4()).digest("hex");

    // 添加任务到队列并记录状态
    const task = { md5, folderPath: extractPath, texFilePath, pdfFilePath };
    taskStatus[md5] = {
      status: "queued",
      folderPath: extractPath,
      texFilePath: texFilePath,
    };
    addTaskToQueue(task);

    res.json({ message: "File uploaded and queued for compilation.", md5 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to handle the file." });
  }
});

// 查询编译状态
app.get("/status/:md5", (req, res) => {
  const md5 = req.params.md5;
  const statusInfo = taskStatus[md5];

  if (!statusInfo) {
    return res.status(404).json({ error: "Task not found." });
  }

  if (statusInfo.status === "failed") {
    res.json({ status: "failed" });
    cleanupTaskFiles(md5);
  }
});

// 下载编译后的PDF文件
app.get("/download/:md5", async (req, res) => {
  const md5 = req.params.md5;
  const statusInfo = taskStatus[md5];

  if (!statusInfo || statusInfo.status !== "completed") {
    return res.status(404).json({ error: "PDF file not available." });
  }

  const pdfFilePath = statusInfo.pdfFilePath;

  // 检查文件是否存在
  if (
    !(await fs
      .access(pdfFilePath)
      .then(() => true)
      .catch(() => false))
  ) {
    return res.status(404).json({ error: "PDF file not found." });
  }

  // 提供文件下载
  res.download(pdfFilePath, async () => {
    // 文件下载完成后清理任务文件
    console.log(`Cleaning up ${pdfFilePath}`);
    await cleanupTaskFiles(md5);
  });
});

// 全部清理接口
app.post("/cleanup", async (req, res) => {
  try {
    // 遍历所有任务并清理已完成任务的文件
    for (const md5 of Object.keys(taskStatus)) {
      if (taskStatus[md5].status === "completed") {
        await cleanupTaskFiles(md5);
      }
    }

    // 清理未完成任务的文件（可选）
    await Promise.all(
      taskQueue.map(async (task) => {
        await fs.rm(task.folderPath, { recursive: true, force: true });
      })
    );

    taskQueue = [];
    taskStatus = {};

    // 清理 uploads 目录下的所有文件和文件夹
    await fs.rm("uploads", { recursive: true, force: true });
    await fs.mkdir("uploads", { recursive: true });

    res.json({ message: "All tasks and uploads have been cleaned up." });
  } catch (error) {
    console.error("Failed to cleanup:", error);
    res.status(500).json({ error: "Cleanup failed." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 启动服务器
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
