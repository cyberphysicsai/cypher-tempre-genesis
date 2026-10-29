// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

contract MockToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public mode;
    address public callback;
    bool public reentryBlocked;
    bytes4 public callbackError;
    bool private inCallback;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    constructor(uint8 decimals_) { decimals = decimals_; }
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function configure(uint8 mode_, address callback_) external {
        mode = mode_;
        callback = callback_;
        balanceOf[address(this)] = 21_000 * 10 ** 18;
        allowance[address(this)][callback_] = 21_000 * 10 ** 18;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == 2) return false;
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        uint256 received = mode == 1 ? amount - 1 : amount;
        balanceOf[to] += received;
        emit Transfer(from, to, received);
        if (mode == 3 && !inCallback) {
            inCallback = true;
            (bool success, bytes memory result) = callback.call(abi.encodeWithSignature("purchase(uint256)", 1));
            inCallback = false;
            reentryBlocked = !success;
            if (result.length >= 4) callbackError = bytes4(result);
        }
        if (mode == 4) { assembly { return(0, 0) } }
        return true;
    }
}
