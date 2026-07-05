# 调用文档 — new-api 兼容渠道管理接口

> 接口兼容 new-api 渠道管理格式，替换 Base URL 和访问令牌即可调用。

## 请求信息

- **Base URL**: `https://open.naci-tech.com`
- **认证请求头**: `Authorization: Bearer <SYSTEM_ACCESS_TOKEN>`
- **Content-Type**: `application/json`

## 接口列表

| 接口 | 说明 |
| --- | --- |
| `GET /api/channel/` | 查询渠道列表 |
| `GET /api/channel/{id}` | 查询单个渠道 |
| `POST /api/channel/` | 创建并发布渠道 |
| `PUT /api/channel/` | 更新渠道，顶层 id 为必填 |

## 调用示例

### 查询列表

```bash
curl -X GET "https://open.naci-tech.com/api/channel/?p=1&page_size=10" \
  -H "Authorization: Bearer <SYSTEM_ACCESS_TOKEN>"
```

```json
{
  "success": true,
  "message": "",
  "data": {
    "items": [
      {
        "id": 123,
        "name": "supplier-openai",
        "type": 1,
        "models": "gpt-4o-mini",
        "group": "openai",
        "priority": 5,
        "weight": 1,
        "auto_ban": 1
      }
    ],
    "total": 1,
    "page": 1,
    "page_size": 10,
    "type_counts": {
      "1": 1
    }
  }
}
```

### 查询详情

```bash
curl -X GET "https://open.naci-tech.com/api/channel/123" \
  -H "Authorization: Bearer <SYSTEM_ACCESS_TOKEN>"
```

```json
{
  "success": true,
  "message": "",
  "data": {
    "id": 123,
    "name": "supplier-openai",
    "type": 1,
    "models": "gpt-4o-mini",
    "group": "openai",
    "priority": 5,
    "weight": 1,
    "auto_ban": 1,
    "used_quota": 1500000,
    "used_amount": 3,
    "site_amounts": [
      {
        "site_id": 1,
        "site_name": "site-a",
        "remote_channel_id": 456,
        "used_quota": 1500000,
        "used_amount": 3
      }
    ]
  }
}
```

#### 查询详情用量字段

> 详情接口会额外返回以下用量信息；列表、创建和更新接口不会返回这些统计字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `used_quota` | number | 当前渠道发布到所有绑定站点后的累计消费额度汇总。 |
| `used_amount` | number | 当前渠道累计消费金额，按 used_quota 换算为金额。 |
| `site_amounts` | array\<object\> | 站点消费明细数组，按绑定站点和远端渠道拆分 used_quota 与 used_amount。 |

### 创建渠道

```bash
curl -X POST "https://open.naci-tech.com/api/channel/" \
  -H "Authorization: Bearer <SYSTEM_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
  "mode": "single",
  "multi_key_mode": "random",
  "channel": {
    "name": "supplier-openai",
    "type": 1,
    "key": "sk-xxxx",
    "base_url": "",
    "models": "gpt-4o-mini",
    "group": "openai",
    "priority": 6
  }
}'
```

```json
{
  "success": true,
  "message": "",
  "data": {
    "id": 123,
    "ids": [123]
  }
}
```

### 更新渠道

```bash
curl -X PUT "https://open.naci-tech.com/api/channel/" \
  -H "Authorization: Bearer <SYSTEM_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
  "id": 123,
  "name": "supplier-openai",
  "type": 1,
  "base_url": "",
  "models": "gpt-4o-mini,gpt-4.1-mini",
  "group": "openai",
  "priority": 6
}'
```

```json
{
  "success": true,
  "message": "",
  "data": {
    "id": 123,
    "name": "supplier-openai",
    "type": 1,
    "models": "gpt-4o-mini,gpt-4.1-mini",
    "group": "openai",
    "priority": 5,
    "weight": 1,
    "auto_ban": 1
  }
}
```

## 请求 Body 示例

### 创建渠道

```json
{
  "mode": "single",
  "multi_key_mode": "random",
  "channel": {
    "name": "supplier-openai",
    "type": 1,
    "key": "sk-xxxx",
    "base_url": "",
    "models": "gpt-4o-mini",
    "group": "openai",
    "priority": 6
  }
}
```

### 更新渠道

```json
{
  "id": 123,
  "name": "supplier-openai",
  "type": 1,
  "base_url": "",
  "models": "gpt-4o-mini,gpt-4.1-mini",
  "group": "openai",
  "priority": 6
}
```

> **请求格式提示**：POST 创建接口使用 new-api 的包裹格式，渠道字段放在 `channel` 对象内；PUT 更新接口使用扁平渠道对象，`id` 必须放在请求体顶层。

> **迁移提示**：推荐按 new-api 原生格式传入 `models` 字符串和 `group` 字符串；平台会兼容 `models` 数组和 `groups` 字段，并在保存和响应时规范化为逗号分隔字符串。

> 参数限制与平台内创建渠道保持一致；系统会按供应商配置校验可用站点、渠道类型、Base URL、模型和分组。

## Response 说明

### 通用成功响应

```json
{
  "success": true,
  "message": "",
  "data": {}
}
```

### 通用失败响应

```json
{
  "success": false,
  "message": "错误原因"
}
```

### 接口返回 data 结构

- **GET /api/channel/ 返回列表结构**：`data.items` 为渠道对象数组，敏感字段 key 不会返回；`data.total`、`data.page`、`data.page_size`、`data.type_counts` 与 new-api 保持一致。
- **GET /api/channel/{id} 返回单个渠道对象**：`data` 为渠道对象，包含 id、name、type、models、group、used_quota、used_amount、site_amounts 等字段，敏感字段 key 不会返回。
- **POST /api/channel/ 返回创建 ID**：`data.id` 为本地模板 ID，`data.ids` 为包含本地模板 ID 的数组。
- **PUT /api/channel/ 返回更新后的渠道对象**：`data` 为更新后的渠道对象，敏感字段 key 不会返回。

## data 字段结构

### 列表 data 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.items` | array\<object\> | 渠道对象数组，只返回当前供应商可管理的渠道。 |
| `data.total` | number | 当前返回的渠道数量。 |
| `data.page` | number | 当前页码。 |
| `data.page_size` | number | 每页数量。 |
| `data.type_counts` | object | 按渠道 type 统计的数量。 |

### 渠道对象字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 本地渠道模板 ID；更新、查询、删除时使用这个 ID。 |
| `name` | string | 渠道名称。 |
| `type` | number | new-api 渠道类型。 |
| `base_url` | string | 渠道上游 Base URL；按供应商白名单校验。 |
| `models` | string | 渠道可用模型，new-api 原生字段；多个模型使用逗号分隔。 |
| `group` | string | 渠道可用分组，new-api 原生字段；按供应商可用分组和站点分组规则校验。 |
| `priority` | number | 渠道优先级；只能填写管理员为当前供应商配置的可选优先级，并受对应启用渠道数量额度限制。 |
| `weight` | number | 平台规范化字段，供应商受限模式下保存为 1。 |
| `auto_ban` | number | 平台规范化字段，供应商受限模式下保存为 1。 |
| `used_quota` | number | 仅详情接口返回；当前渠道绑定站点的总消费额度。 |
| `used_amount` | number | 仅详情接口返回；当前渠道绑定站点的总消费金额。 |
| `site_amounts` | array\<object\> | 仅详情接口返回；按站点拆分的消费金额明细。 |
| 其他 new-api 渠道字段 | any | 除 key 外会按原渠道配置保存；部分字段会按供应商配置校验、规范化或移除。 |
| `key` | string | 敏感字段，列表和详情不会返回；更新时不传 key 会保留原密钥。 |

### site_amounts 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `site_id` | number | 本地站点 ID。 |
| `site_name` | string | 站点名称。 |
| `remote_channel_id` | number | 该站点实际发布后的远端渠道 ID。 |
| `used_quota` | number | 该站点远端渠道的消费额度。 |
| `used_amount` | number | 该站点远端渠道的消费金额。 |

### 创建 data 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.id` | number | 本地渠道模板 ID。 |
| `data.ids` | array\<number\> | new-api 兼容字段，当前为包含本地模板 ID 的数组。 |

### 更新 data 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | object | 更新后的渠道对象，包含 id、name、type、models、group 等字段。 |
