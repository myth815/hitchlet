/**
 * 计算资源服务 v1.3 接口总索引（设计骨架，尚非实现）。
 *
 * 消费者与 GUI 首选 ./contracts/public；这里兼容原总入口，供控制端内部浏览全部合同。
 * 阅读顺序：public/consumer → services → domain → provider → agent。
 * 输入必须经过运行时 schema；readonly/字面量联合不能替代认证、时间检查和事务。
 * Docker 为当前交付，Hyper-V/Tart 为后置合同，不要求提前实现。
 */
export type * from './contracts/common';
export type * from './contracts/consumer';
export type * from './contracts/domain';
export type * from './contracts/provider';
export type * from './contracts/agent';
export type * from './contracts/services';
