/* Hardware-free ABI fixture: compile against the installed Linux UAPI. */
#include <linux/cec.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/ioctl.h>

#define VALUE(name) printf(#name "=%lu\n", (unsigned long)(name))
#define LAYOUT(py, c) \
    printf(py ".size=%lu\n", (unsigned long)sizeof(struct c)); \
    printf(py ".alignment=%lu\n", (unsigned long)_Alignof(struct c))
#define FIELD(py, c, field) \
    printf(py "." #field "=%lu\n", (unsigned long)offsetof(struct c, field))

int main(void)
{
    LAYOUT("CecMsg", cec_msg);
    FIELD("CecMsg", cec_msg, tx_ts);
    FIELD("CecMsg", cec_msg, rx_ts);
    FIELD("CecMsg", cec_msg, len);
    FIELD("CecMsg", cec_msg, timeout);
    FIELD("CecMsg", cec_msg, sequence);
    FIELD("CecMsg", cec_msg, flags);
    FIELD("CecMsg", cec_msg, msg);
    FIELD("CecMsg", cec_msg, reply);
    FIELD("CecMsg", cec_msg, rx_status);
    FIELD("CecMsg", cec_msg, tx_status);
    FIELD("CecMsg", cec_msg, tx_arb_lost_cnt);
    FIELD("CecMsg", cec_msg, tx_nack_cnt);
    FIELD("CecMsg", cec_msg, tx_low_drive_cnt);
    FIELD("CecMsg", cec_msg, tx_error_cnt);
    LAYOUT("CecCaps", cec_caps);
    FIELD("CecCaps", cec_caps, driver);
    FIELD("CecCaps", cec_caps, name);
    FIELD("CecCaps", cec_caps, available_log_addrs);
    FIELD("CecCaps", cec_caps, capabilities);
    FIELD("CecCaps", cec_caps, version);
    LAYOUT("CecLogAddrs", cec_log_addrs);
    FIELD("CecLogAddrs", cec_log_addrs, log_addr);
    FIELD("CecLogAddrs", cec_log_addrs, log_addr_mask);
    FIELD("CecLogAddrs", cec_log_addrs, cec_version);
    FIELD("CecLogAddrs", cec_log_addrs, num_log_addrs);
    FIELD("CecLogAddrs", cec_log_addrs, vendor_id);
    FIELD("CecLogAddrs", cec_log_addrs, flags);
    FIELD("CecLogAddrs", cec_log_addrs, osd_name);
    FIELD("CecLogAddrs", cec_log_addrs, primary_device_type);
    FIELD("CecLogAddrs", cec_log_addrs, log_addr_type);
    FIELD("CecLogAddrs", cec_log_addrs, all_device_types);
    FIELD("CecLogAddrs", cec_log_addrs, features);
    LAYOUT("CecStateChange", cec_event_state_change);
    FIELD("CecStateChange", cec_event_state_change, phys_addr);
    FIELD("CecStateChange", cec_event_state_change, log_addr_mask);
    FIELD("CecStateChange", cec_event_state_change, have_conn_info);
    LAYOUT("CecLostMsgs", cec_event_lost_msgs);
    FIELD("CecLostMsgs", cec_event_lost_msgs, lost_msgs);
    LAYOUT("CecEvent", cec_event);
    FIELD("CecEvent", cec_event, ts);
    FIELD("CecEvent", cec_event, event);
    FIELD("CecEvent", cec_event, flags);
    FIELD("CecEvent", cec_event, state_change);
    FIELD("CecEvent", cec_event, lost_msgs);
    FIELD("CecEvent", cec_event, raw);
    VALUE(CEC_ADAP_G_CAPS);
    VALUE(CEC_ADAP_G_PHYS_ADDR);
    VALUE(CEC_ADAP_G_LOG_ADDRS);
    VALUE(CEC_ADAP_S_LOG_ADDRS);
    VALUE(CEC_TRANSMIT);
    VALUE(CEC_RECEIVE);
    VALUE(CEC_DQEVENT);
    VALUE(CEC_G_MODE);
    VALUE(CEC_S_MODE);
    VALUE(CEC_CAP_LOG_ADDRS);
    VALUE(CEC_CAP_TRANSMIT);
    VALUE(CEC_CAP_CONNECTOR_INFO);
    VALUE(CEC_MODE_EXCL_INITIATOR);
    VALUE(CEC_MODE_EXCL_FOLLOWER);
    VALUE(CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU);
    VALUE(CEC_LOG_ADDR_TYPE_PLAYBACK);
    VALUE(CEC_OP_PRIM_DEVTYPE_PLAYBACK);
    VALUE(CEC_OP_ALL_DEVTYPE_PLAYBACK);
    VALUE(CEC_OP_CEC_VERSION_1_4);
    VALUE(CEC_VENDOR_ID_NONE);
    VALUE(CEC_PHYS_ADDR_INVALID);
    VALUE(CEC_EVENT_STATE_CHANGE);
    VALUE(CEC_EVENT_LOST_MSGS);
    VALUE(CEC_EVENT_FL_INITIAL_STATE);
    VALUE(CEC_EVENT_FL_DROPPED_EVENTS);
    VALUE(CEC_TX_STATUS_OK);
    VALUE(CEC_TX_STATUS_MAX_RETRIES);
    VALUE(CEC_TX_STATUS_ABORTED);
    VALUE(CEC_TX_STATUS_TIMEOUT);
    VALUE(CEC_RX_STATUS_OK);
    VALUE(CEC_MSG_IMAGE_VIEW_ON);
    VALUE(CEC_MSG_ACTIVE_SOURCE);
    return 0;
}
