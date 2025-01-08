# 使用 texlive/texlive:TL2020-historic 作为基础镜像
FROM texlive/texlive:TL2020-historic

# 设置环境变量以避免非交互式提示
ENV DEBIAN_FRONTEND=noninteractive

# 安装 Node.js 和 npm
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_16.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 安装 latexmk (如果在基础镜像中没有)
RUN tlmgr install latexmk

# 创建应用目录并设置为工作目录
WORKDIR /usr/src/app

# 将 package.json 和 package-lock.json 复制到容器内
COPY package*.json ./

# 安装应用程序依赖
RUN npm install

# 将应用程序代码复制到容器内
COPY index.html .
COPY index.js .

# 暴露应用程序端口
EXPOSE 3000

# 启动命令
CMD ["node", "index.js"]