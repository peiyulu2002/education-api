# Pretty English - Dockerfile for Tencent Cloud CloudBase 云托管
# 仓库根目录直接包含 server.js / package.json / schema.sql / public/
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖声明并安装
COPY package*.json /app/
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
    && npm install --production

# 复制全部源码（受 .dockerignore 排除 node_modules / .env / *.db）
COPY . /app

EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
