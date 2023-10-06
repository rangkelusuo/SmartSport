/**
 * Notes: 支付模块业务逻辑
 * Ver : CCMiniCloud Framework 3.2.11 ALL RIGHTS RESERVED BY cclinux0730 (wechat)
 * Date: 2022-07-04 07:48:00 
 */

const BaseProjectService = require('./base_project_service.js');
const dataUtil = require('../../../framework/utils/data_util.js');
const cloudBase = require('../../../framework/cloud/cloud_base.js');

const timeUtil = require('../../../framework/utils/time_util.js');
const util = require('../../../framework/utils/util.js');
const config = require('../../../config/config.js');
const PayModel = require('../model/pay_model.js');
const UserModel = require('../model/user_model.js');

const PAY_TIMEOUT = 60 * 5; //支付过期时间 秒  最少60秒有效 


class PayService extends BaseProjectService {

    // 回调业务处理
    async doOrderAfterPayCallback(tradeNo, time) {

        const ActivityJoinModel = require('../model/activity_join_model.js');

        // 支付成功后处理缴费记录 
        let where = {
            ACTIVITY_JOIN_PAY_TRADE_NO: tradeNo,
            ACTIVITY_JOIN_STATUS: ['in', [ActivityJoinModel.STATUS.WAIT, ActivityJoinModel.STATUS.SUCC]], //待审核和已报名成功的可以成功付费
        };

        let activityJoin = await ActivityJoinModel.getOne(where);

        if (!activityJoin) {
            // 如果订单不存在，则退款
            this.refundPay(tradeNo, '缴费支付超时退款', false);
            return;
        }

        // 更改支付状态和时间
        await ActivityJoinModel.edit(where, { ACTIVITY_JOIN_PAY_STATUS: 1, ACTIVITY_JOIN_PAY_TIME: time });


        // 异步统计 
        this._bizStat(activityJoin.ACTIVITY_JOIN_ACTIVITY_ID);
    }

    async _bizStat(activityId) {
        const ActivityJoinModel = require('../model/activity_join_model.js');
        const ActivityModel = require('../model/activity_model.js');

        // 总数
        let where = {
            ACTIVITY_JOIN_ACTIVITY_ID: activityId,
            ACTIVITY_JOIN_STATUS: ['in', [ActivityJoinModel.STATUS.WAIT, ActivityJoinModel.STATUS.SUCC]],
        }
        let cnt = await ActivityJoinModel.count(where);


        // 已支付记录
        let wherePayCnt = {
            ACTIVITY_JOIN_ACTIVITY_ID: activityId,
            ACTIVITY_JOIN_PAY_STATUS: 1,
            ACTIVITY_JOIN_STATUS: ['in', [ActivityJoinModel.STATUS.WAIT, ActivityJoinModel.STATUS.SUCC]],
        }
        let payCnt = await ActivityJoinModel.count(wherePayCnt);


        // 已支付金额
        let wherePayFee = {
            ACTIVITY_JOIN_ACTIVITY_ID: activityId,
            ACTIVITY_JOIN_PAY_STATUS: 1,
            ACTIVITY_JOIN_STATUS: ['in', [ActivityJoinModel.STATUS.WAIT, ActivityJoinModel.STATUS.SUCC]],
        }
        let payFee = await ActivityJoinModel.sum(wherePayFee, 'ACTIVITY_JOIN_PAY_FEE');

        // 报名用户头像列表
        let whereUserList = {
            ACTIVITY_JOIN_ACTIVITY_ID: activityId,
            ACTIVITY_JOIN_STATUS: ActivityJoinModel.STATUS.SUCC,
            ACTIVITY_JOIN_PAY_STATUS: ['in', [1, 99]]
        }
        let joinParams = {
            from: UserModel.CL,
            localField: 'ACTIVITY_JOIN_USER_ID',
            foreignField: 'USER_MINI_OPENID',
            as: 'user',
        };
        let orderBy = {
            ACTIVITY_JOIN_ADD_TIME: 'desc'
        }
        let userList = await ActivityJoinModel.getListJoin(joinParams, whereUserList, 'ACTIVITY_JOIN_ADD_TIME,user.USER_MINI_OPENID,user.USER_NAME,user.USER_PIC', orderBy, 1, 6, false, 0);
        userList = userList.list;

        for (let k = 0; k < userList.length; k++) {
            userList[k] = userList[k].user;
        }

        let data = {
            ACTIVITY_JOIN_CNT: cnt,
            ACTIVITY_PAY_CNT: payCnt,
            ACTIVITY_PAY_FEE: payFee,

            ACTIVITY_USER_LIST: userList
        }
        await ActivityModel.edit(activityId, data);

    }


    // 查询支付结果
    async queryPayResult(tradeNo) {
        if (!tradeNo) return false;

        let parmas = {
            'out_trade_no': tradeNo,
            'subMchId': config.PAY_MCH_ID, //这里要注意：虽然key是子商户id，实际上就是普通商户id
            'nonceStr': dataUtil.genRandomString(32)
        }

        const cloud = cloudBase.getCloud();
        let res = await cloud.cloudPay.queryOrder(parmas);
        console.log('queryPayResult', res);

        if (!res || res.returnCode != 'SUCCESS' || res.resultCode != 'SUCCESS' || res.tradeState != 'SUCCESS') return false;

        return true;
    }

    // 查询并且修复支付结果, 只有支付成功返回True
    async fixPayResult(tradeNo) {
        if (!tradeNo) return false;

        let parmas = {
            'out_trade_no': tradeNo,
            'subMchId': config.PAY_MCH_ID, //这里要注意：虽然key是子商户id，实际上就是普通商户id
            'nonceStr': dataUtil.genRandomString(32)
        }

        const cloud = cloudBase.getCloud();
        let res = await cloud.cloudPay.queryOrder(parmas);
        console.log('fixPayResult', res);

        let where = {
            PAY_TRADE_NO: tradeNo
        }
        if (!res || res.returnCode != 'SUCCESS' || res.resultCode != 'SUCCESS' || !res.tradeState) {
            // 支付失败
            await PayModel.edit(where, {
                PAY_STATUS: PayModel.STATUS.FAIL,
                PAY_STATUS_DESC: PayModel.STATUS_DESC.FAIL
            });
            return false;
        }

        let status = PayModel.STATUS.FAIL;
        let statusDesc = PayModel.STATUS_DESC.FAIL;

        switch (res.tradeState) {
            case 'SUCCESS':
                { // 支付成功
                    await PayModel.edit(where,
                        {
                            PAY_STATUS: PayModel.STATUS.SUCCESS,
                            PAY_STATUS_DESC: PayModel.STATUS_DESC.SUCCESS,
                            PAY_END_TIME: this._fmtEndTime(res.timeEnd),
                            PAY_TRANSACTION_ID: res.transactionId //更新微信订单号
                        }
                    );
                    return true;
                }
            case 'NOTPAY':
                {
                    status = PayModel.STATUS.NOTPAY;
                    statusDesc = PayModel.STATUS_DESC.NOTPAY;
                    break;
                }
            case 'REFUND':
                {
                    status = PayModel.STATUS.REFUND;
                    statusDesc = PayModel.STATUS_DESC.REFUND;
                    break;
                }
            case 'CLOSED':
                {
                    status = PayModel.STATUS.CLOSED;
                    statusDesc = PayModel.STATUS_DESC.CLOSED;
                    break;
                }
            default:
                {
                    status = PayModel.STATUS.FAIL;
                    statusDesc = PayModel.STATUS_DESC.FAIL;
                    break;
                }
        }

        let payData = {
            PAY_STATUS: status,
            PAY_STATUS_DESC: statusDesc,
        }

        await PayModel.edit(where, payData);
        return false;

    }

    // 支付前预处理
    async beforePay(
        {
            type = 'ORDER', //业务类型
            userId,
            money,
            body,
            detail = ''
        }) {

        // 判断用户是否有未支付的订单

        // ************** 支付
        // 基本参数设定
        money = Math.round(Number(money));
        if (!money) this.AppError('支付错误金额错误');
        if (money > 100000 * 100) this.AppError('支付错误金额过大');


        // 测试模式
        if (config.PAY_TEST_MODE) money = 2;

        //32位随机串
        let nonceStr = dataUtil.genRandomString(32);

        //商户订单号
        let tradeNo = type + timeUtil.time('YMDhms') + 'M' + money + '-';
        tradeNo += dataUtil.genRandomString(32 - tradeNo.length);

        // 商品简要描述
        body = body.substr(0, 128);

        let attach = global.PID || '';

        let parmas = {
            'body': body,
            'outTradeNo': tradeNo,
            'spbillCreateIp': '127.0.0.1',
            'subMchId': config.PAY_MCH_ID, //这里要注意：虽然key是子商户id，实际上就是普通商户id
            'totalFee': money, //第二个坑：注意必须是数字，如果不是数字，则会报错unifiedOrder:fail wx api error: -202
            'envId': config.CLOUD_ID, //这里是回调函数所属的的云环境id
            'functionName': 'mcloud', //这个是回调函数名
            'nonceStr': nonceStr, //第三个坑：官方文档中相关云函数代码没有nonceStr和tradeType，测试的时候会报nonceStr不存在的错，翻看文档才发现这个是必填项，直接粘过来以后还需要加上这两个参数
            'tradeType': 'JSAPI',
            'attach': attach,
            'timeExpire': timeUtil.time('YMDhms', PAY_TIMEOUT) //结束时间(秒) 
        }

        console.log(parmas)

        const cloud = cloudBase.getCloud();
        let res = await cloud.cloudPay.unifiedOrder(parmas);
        console.log(res);
        if (res.resultCode !== 'SUCCESS' || res.returnCode !== 'SUCCESS' || !res.prepayId) {
            console.error('支付预请求失败，请重新提交', res);
            this.AppError('支付失败，请重新提交');
        }

        // 入库 
        let data = {};
        data.PAY_STATUS = PayModel.STATUS.NOTPAY;
        data.PAY_STATUS_DESC = PayModel.STATUS_DESC.NOTPAY;

        data.PAY_TRADE_NO = tradeNo;
        data.PAY_NONCESTR = res.payment.nonceStr;
        data.PAY_TIMESTAMP = res.payment.timeStamp;
        data.PAY_PREPAY_ID = res.prepayId;
        data.PAY_BODY = body;
        data.PAY_TOTAL_FEE = money;

        data.PAY_TYPE = type;
        data.PAY_ATTACH = attach;
        data.PAY_USER_ID = userId;
        data.PAY_DETAIL = detail;

        await PayModel.insert(data);


        // 返回支付参数
        let payment = res.payment;
        payment.tradeNo = tradeNo;
        return {
            tradeNo,
            payment,
            money
        };

    }


    /* 支付回调 理解为只有支付成功才回调
    https://pay.weixin.qq.com/wiki/doc/api/jsapi.php?chapter=9_7&index=8
    1、同样的通知可能会多次发送给商户系统。商户系统必须能够正确处理重复的通知。
    2、后台通知交互时，如果微信收到商户的应答不符合规范或超时，微信会判定本次通知失败，重新发送通知，直到成功为止（在通知一直不成功的情况下，微信总共会发起多次通知，通知频率为15s/15s/30s/3m/10m/20m/30m/30m/30m/60m/3h/3h/3h/6h/6h - 总计 24h4m）这里通知发送可能会多台服务器进行发送，且发送时间可能会在几秒内，但微信不保证通知最终一定能成功。
    3、在订单状态不明或者没有收到微信支付结果通知的情况下
    */
    async callbackPay(event) {
        let money = Math.ceil(Number(event.totalFee));
        if (!money) money = 0;

        console.log('>>** Enter payback ...', event);



        // 支付状态
        let payStatus = (event.resultCode == 'SUCCESS' && event.returnCode == 'SUCCESS') ? PayModel.STATUS.SUCCESS : PayModel.STATUS.FAIL;


        let payStatusDesc = (event.resultCode == 'SUCCESS' && event.returnCode == 'SUCCESS') ? PayModel.STATUS_DESC.SUCCESS : PayModel.STATUS_DESC.FAIL;

        let where = {
            PAY_TRADE_NO: event.outTradeNo,
            PAY_TOTAL_FEE: money,
        }

        if (payStatus == PayModel.STATUS.SUCCESS) { // 支付成功才修改状态 

            let data = {
                PAY_END_TIME: this._fmtEndTime(event.timeEnd),
                PAY_STATUS: payStatus,
                PAY_STATUS_DESC: payStatusDesc,
                PAY_TRANSACTION_ID: event.transactionId //更新微信订单号
            }

            let effect = await PayModel.edit(where, data);
            console.log('>> payBack effect=' + effect);
            if (effect) {
                // 首次修改订单状态
                this.doOrderAfterPayCallback(event.outTradeNo, this._fmtEndTime(event.timeEnd));
            }

        }

        console.log('>>** Enter payback END.')

        return {
            'errcode': 0,
            'errmsg': 'succ'
        };
    }


    // 退款
    async refundPay(tradeNo, desc = '', isException = true) {

        let pay = await PayModel.getOne({ PAY_TRADE_NO: tradeNo });
        if (!pay) this.AppError('没有找到该支付记录');

        let ret = await this.queryPayResult(tradeNo);
        if (!ret) {
            if (isException) this.AppError('该记录未支付或者已退款');
            return false;
        }

        const cloud = cloudBase.getCloud();
        let refundNo = pay.PAY_TRADE_NO + '-' + dataUtil.genRandomString(31);
        let params = {
            sub_mch_id: config.PAY_MCH_ID, //子商户号
            nonce_str: dataUtil.genRandomString(32), //随机字符串 没有实际作用 
            out_trade_no: tradeNo, //商户订单号
            out_refund_no: refundNo, // 商户退款单号
            total_fee: pay.PAY_TOTAL_FEE, // 订单金额
            refund_fee: pay.PAY_TOTAL_FEE,// 申请退款金额
            refund_desc: desc, //退款原因
        }

        let res = await cloud.cloudPay.refund(params);
        console.log('refundPay', res);

        if (res.resultCode !== 'SUCCESS' || res.returnCode !== 'SUCCESS' || !res.refundId) {
            console.error('退款失败，请重新提交', res);
            if (isException)
                this.AppError('退款失败：' + res.errCodeDes);
            else
                return false;
        }

        let data = {
            PAY_REFUND_ID: res.refundId,
            PAY_OUT_REFUND_NO: refundNo,
            PAY_REFUND_TIME: this._timestamp,
            PAY_STATUS: PayModel.STATUS.REFUND,
            PAY_STATUS_DESC: PayModel.STATUS_DESC.REFUND,
            PAY_REFUND_DESC: desc
        }
        await PayModel.edit(pay._id, data);

        return true;
    }

    // 关闭
    async closePay(tradeNo) {
        if (!tradeNo) return true;

        const cloud = cloudBase.getCloud();
        let params = {
            sub_mch_id: config.PAY_MCH_ID, //子商户号
            nonce_str: dataUtil.genRandomString(32), //随机字符串 没有实际作用 
            out_trade_no: tradeNo, //商户订单号  
        }

        let res = await cloud.cloudPay.closeOrder(params);
        console.log('closePay', res);

        if (res.resultCode !== 'SUCCESS' || res.returnCode !== 'SUCCESS') {
            console.error('关闭失败，请重新提交', res);
            // this.AppError('退款失败：' + res.errCodeDes);
            return false;
        }

        // 更新状态
        await this.fixPayResult(tradeNo);

        return true;

    }

    _fmtEndTime(time) {
        time = time.substr(0, 4) + '-' + time.substr(4, 2) + '-' + time.substr(6, 2) + ' ' + time.substr(8, 2) + ':' + time.substr(10, 2) + ':' + time.substr(12, 2);
        return timeUtil.time2Timestamp(time);
    }


    /**流水分页列表 */
    async getPayFlowList({
        search, // 搜索条件
        sortType, // 搜索菜单
        sortVal, // 搜索菜单
        orderBy, // 排序 
        page,
        size,
        isTotal = true,
        oldTotal
    }) {

        orderBy = orderBy || {
            'PAY_ADD_TIME': 'desc'
        };
        let fields = '*';
        let where = {};

        if (!search) search = '';
        search = String(search).trim();
        if (search) {
            let openId = 'null';
            let user = await UserModel.getOne({ USER_MOBILE: search });
            if (user) openId = user.USER_MINI_OPENID;
            where.PAY_USER_ID = openId;
        }

        if (sortType && util.isDefined(sortVal)) {
            // 搜索菜单
            switch (sortType) {
                case 'status': {
                    where.PAY_STATUS = Number(sortVal);
                    break;
                }
                case 'sort': {
                    orderBy = this.fmtOrderBySort(sortVal, 'PAY_ADD_TIME');
                    break;
                }
            }
        }

        return await PayModel.getList(where, fields, orderBy, page, size, isTotal, oldTotal);
    }



}

module.exports = PayService;